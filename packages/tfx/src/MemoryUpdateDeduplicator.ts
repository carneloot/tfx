import * as Clock from 'effect/Clock';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';

import type { CompletedOutcome } from './DispatchOutcome.js';
import {
	UpdateDeduplicator,
	type ObservedCompletion,
	type UpdateDeduplicatorService,
} from './UpdateDeduplicator.js';
interface Row {
	generation: number;
	leaseExpiresAt: number;
	completed?: CompletedOutcome;
	retentionUntil?: number;
	waiters: Array<Deferred.Deferred<ObservedCompletion>>;
	released: boolean;
}
const make: Effect.Effect<UpdateDeduplicatorService> = Effect.gen(function* () {
	const rows = new Map<number, Row>();
	const semaphore = yield* Semaphore.make(1);
	const locked = <A>(f: () => A) => semaphore.withPermit(Effect.sync(f));
	return {
		diagnostics: { mode: 'memory', backend: 'memory' },
		claim: (updateId, options = {}) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const duration = options.leaseDuration ?? 30_000;
				const waitTimeout = options.waitTimeout ?? 5_000;
				const result = yield* locked(() => {
					const current = rows.get(updateId);
					if (current?.completed !== undefined && current.retentionUntil! > now)
						return { _tag: 'Completed' as const, outcome: current.completed };
					if (
						current === undefined ||
						current.released ||
						current.leaseExpiresAt <= now ||
						(current.completed !== undefined && current.retentionUntil! <= now)
					) {
						const row: Row = {
							generation: (current?.generation ?? 0) + 1,
							leaseExpiresAt: now + duration,
							waiters: [],
							released: false,
						};
						rows.set(updateId, row);
						return {
							_tag: 'Acquired' as const,
							token: { updateId, generation: row.generation },
						};
					}
					const deferred = Deferred.makeUnsafe<ObservedCompletion>();
					current.waiters.push(deferred);
					const observe = Deferred.await(deferred);
					return {
						_tag: 'InProgress' as const,
						await: Effect.race(
							observe,
							Effect.as(Effect.sleep(waitTimeout), {
								_tag: 'TimedOut' as const,
							}),
						),
					};
				});
				return result;
			}),
		heartbeat: (token, duration = 30_000) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				locked(() => {
					const row = rows.get(token.updateId);
					if (
						row === undefined ||
						row.generation !== token.generation ||
						row.released ||
						row.completed !== undefined
					)
						return false;
					row.leaseExpiresAt = now + duration;
					return true;
				}),
			),
		complete: (token, outcome, retention = 86_400_000) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				locked(() => {
					const row = rows.get(token.updateId);
					if (
						row === undefined ||
						row.generation !== token.generation ||
						row.released ||
						row.completed !== undefined
					)
						return false;
					row.completed = outcome;
					row.retentionUntil = now + retention;
					for (const waiter of row.waiters.splice(0))
						Deferred.doneUnsafe(
							waiter,
							Effect.succeed({ _tag: 'Completed', outcome }),
						);
					return true;
				}),
			),
		release: (token) =>
			locked(() => {
				const row = rows.get(token.updateId);
				if (
					row === undefined ||
					row.generation !== token.generation ||
					row.released ||
					row.completed !== undefined
				)
					return false;
				row.released = true;
				row.leaseExpiresAt = 0;
				for (const waiter of row.waiters.splice(0))
					Deferred.doneUnsafe(waiter, Effect.succeed({ _tag: 'Released' }));
				return true;
			}),
	};
});
export const layerMemory: Layer.Layer<UpdateDeduplicator> = Layer.effect(
	UpdateDeduplicator,
	make,
);

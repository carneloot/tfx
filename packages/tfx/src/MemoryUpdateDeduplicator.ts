import * as DateTime from 'effect/DateTime';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
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
	leaseExpiresAt: DateTime.Utc;
	completed?: CompletedOutcome;
	retentionUntil?: DateTime.Utc;
	completion: Deferred.Deferred<ObservedCompletion>;
	released: boolean;
}
const positive = (value: Duration.Duration, name: string): void => {
	if (!Duration.isFinite(value) || !Duration.isPositive(value))
		throw new TypeError(`${name} must be finite and positive`);
};
const make: Effect.Effect<UpdateDeduplicatorService> = Effect.gen(function* () {
	const rows = new Map<number, Row>();
	let generation = 0;
	const semaphore = yield* Semaphore.make(1);
	const locked = <A>(f: () => A) => semaphore.withPermit(Effect.sync(f));
	return {
		diagnostics: { mode: 'memory', backend: 'memory' },
		claim: (updateId, options = {}) =>
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const duration = options.leaseDuration ?? Duration.seconds(30);
				const waitTimeout = options.waitTimeout ?? Duration.seconds(5);
				positive(duration, 'leaseDuration');
				positive(waitTimeout, 'waitTimeout');
				const result = yield* locked(() => {
					let scanned = 0;
					for (const [id, row] of rows) {
						if (scanned++ >= 16) break;
						if (
							row.released ||
							(row.completed !== undefined &&
								DateTime.isLessThanOrEqualTo(row.retentionUntil!, now))
						)
							rows.delete(id);
					}
					const current = rows.get(updateId);
					if (
						current?.completed !== undefined &&
						DateTime.isGreaterThan(current.retentionUntil!, now)
					)
						return { _tag: 'Completed' as const, outcome: current.completed };
					if (
						current === undefined ||
						current.released ||
						DateTime.isLessThanOrEqualTo(current.leaseExpiresAt, now) ||
						(current.completed !== undefined &&
							DateTime.isLessThanOrEqualTo(current.retentionUntil!, now))
					) {
						const row: Row = {
							generation: ++generation,
							leaseExpiresAt: DateTime.addDuration(now, duration),
							completion: Deferred.makeUnsafe<ObservedCompletion>(),
							released: false,
						};
						rows.set(updateId, row);
						return {
							_tag: 'Acquired' as const,
							token: { updateId, generation: row.generation },
						};
					}
					const observe = Deferred.await(current.completion);
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
		heartbeat: (token, duration = Duration.seconds(30)) =>
			Effect.gen(function* () {
				positive(duration, 'leaseDuration');
				const now = yield* DateTime.now;
				return yield* locked(() => {
					const row = rows.get(token.updateId);
					if (
						row === undefined ||
						row.generation !== token.generation ||
						row.released ||
						row.completed !== undefined
					)
						return false;
					row.leaseExpiresAt = DateTime.addDuration(now, duration);
					return true;
				});
			}),
		complete: (token, outcome, retention = Duration.days(1)) =>
			Effect.gen(function* () {
				positive(retention, 'retention');
				const now = yield* DateTime.now;
				return yield* locked(() => {
					const row = rows.get(token.updateId);
					if (
						row === undefined ||
						row.generation !== token.generation ||
						row.released ||
						row.completed !== undefined
					)
						return false;
					row.completed = outcome;
					row.retentionUntil = DateTime.addDuration(now, retention);
					Deferred.doneUnsafe(
						row.completion,
						Effect.succeed({ _tag: 'Completed', outcome }),
					);
					return true;
				});
			}),
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
				row.leaseExpiresAt = DateTime.makeUnsafe(0);
				Deferred.doneUnsafe(
					row.completion,
					Effect.succeed({ _tag: 'Released' }),
				);
				return true;
			}),
	};
});
export const layerMemory: Layer.Layer<UpdateDeduplicator> = Layer.effect(
	UpdateDeduplicator,
	make,
);

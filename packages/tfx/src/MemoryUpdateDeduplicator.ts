import * as DateTime from 'effect/DateTime';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';

import type { CompletedOutcome } from './DispatchOutcome.js';
import { makeCursor, sweep } from './internal/BoundedMapSweep.js';
import {
	UpdateDeduplicator,
	UpdateDeduplicatorError,
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
const positive = (
	value: Duration.Duration,
	name: string,
): Effect.Effect<void, UpdateDeduplicatorError> =>
	Duration.isFinite(value) &&
	!Duration.isZero(value) &&
	!Duration.isNegative(value)
		? Effect.void
		: Effect.fail(
				new UpdateDeduplicatorError(
					'InvariantViolation',
					`${name} must be a finite positive duration`,
				),
			);
const make: Effect.Effect<UpdateDeduplicatorService> = Effect.gen(function* () {
	const rows = new Map<number, Row>();
	const cleanup = makeCursor<number, Row>();
	let generation = 0;
	const semaphore = yield* Semaphore.make(1);
	const locked = <A>(f: () => A) => semaphore.withPermit(Effect.sync(f));
	return {
		diagnostics: { mode: 'memory', backend: 'memory' },
		claim: Effect.fn('MemoryUpdateDeduplicator.claim')(function* (
			updateId,
			options = {},
		) {
			const duration = options.leaseDuration ?? Duration.seconds(30);
			const waitTimeout = options.waitTimeout ?? Duration.seconds(5);
			yield* positive(duration, 'leaseDuration');
			yield* positive(waitTimeout, 'waitTimeout');
			const now = yield* DateTime.now;
			const result = yield* locked(() => {
				sweep(
					rows,
					cleanup,
					(row) =>
						row.released ||
						(row.completed !== undefined &&
							DateTime.isLessThanOrEqualTo(row.retentionUntil!, now)),
					16,
				);
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
		heartbeat: Effect.fn('MemoryUpdateDeduplicator.heartbeat')(function* (
			token,
			duration = Duration.seconds(30),
		) {
			yield* positive(duration, 'leaseDuration');
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
		complete: Effect.fn('MemoryUpdateDeduplicator.complete')(function* (
			token,
			outcome,
			retention = Duration.days(1),
		) {
			yield* positive(retention, 'retention');
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
		release: Effect.fn('MemoryUpdateDeduplicator.release')((token) =>
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
				Deferred.doneUnsafe(
					row.completion,
					Effect.succeed({ _tag: 'Released' }),
				);
				rows.delete(token.updateId);
				return true;
			}),
		),
	};
});
export const layerMemory: Layer.Layer<UpdateDeduplicator> = Layer.effect(
	UpdateDeduplicator,
	make,
);

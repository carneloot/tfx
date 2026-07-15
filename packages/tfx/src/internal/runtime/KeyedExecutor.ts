import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';

import type { PartitionKey } from '../../Partitioning.js';
interface Task<A, E, R> {
	readonly key: PartitionKey;
	readonly effect: Effect.Effect<A, E, R>;
	readonly result: Deferred.Deferred<A, E>;
}
export interface KeyedExecutor {
	readonly submit: <A, E, R>(
		key: PartitionKey,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}
export const make = (options: {
	readonly concurrency: number;
	readonly capacity: number;
}): Effect.Effect<KeyedExecutor, never, Scope.Scope> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.concurrency) || options.concurrency <= 0)
			throw new TypeError('concurrency must be positive');
		if (!Number.isInteger(options.capacity) || options.capacity <= 0)
			throw new TypeError('capacity must be positive');
		const queue = yield* Queue.bounded<Task<any, any, any>>(options.capacity);
		const global = yield* Semaphore.make(options.concurrency);
		const registry = yield* Semaphore.make(1);
		const partitions = new Map<PartitionKey, Semaphore.Semaphore>();
		const partition = (key: PartitionKey) =>
			registry.withPermit(
				Effect.gen(function* () {
					const existing = partitions.get(key);
					if (existing !== undefined) return existing;
					const created = yield* Semaphore.make(1);
					partitions.set(key, created);
					return created;
				}),
			);
		const loop: Effect.Effect<never, never, Scope.Scope> = Effect.flatMap(
			Queue.take(queue),
			(task) =>
				Effect.andThen(
					Effect.forkScoped(
						Effect.flatMap(partition(task.key), (keyPermit) =>
							keyPermit.withPermit(
								global.withPermit(Deferred.complete(task.result, task.effect)),
							),
						),
					),
					loop,
				),
		);
		yield* Effect.forkScoped(loop);
		return {
			submit: (key, effect) =>
				Effect.gen(function* () {
					const result = yield* Deferred.make<any, any>();
					yield* Queue.offer(queue, { key, effect, result });
					return yield* Deferred.await(result);
				}) as never,
		};
	});

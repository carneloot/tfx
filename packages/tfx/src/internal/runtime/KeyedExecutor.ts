import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';

import type { PartitionKey } from '../../Partitioning.js';
interface Task<A, E> {
	readonly key: PartitionKey;
	readonly effect: Effect.Effect<A, E>;
	readonly result: Deferred.Deferred<A, E>;
	readonly cancelled: Deferred.Deferred<void>;
	readonly settled: Deferred.Deferred<void>;
}
interface Partition {
	readonly semaphore: Semaphore.Semaphore;
	users: number;
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
		const queue = yield* Queue.bounded<Task<any, any>>(options.capacity);
		const admission = yield* Semaphore.make(options.capacity);
		const global = yield* Semaphore.make(options.concurrency);
		const registry = yield* Semaphore.make(1);
		const partitions = new Map<PartitionKey, Partition>();
		const acquirePartition = (key: PartitionKey) =>
			registry.withPermit(
				Effect.gen(function* () {
					const existing = partitions.get(key);
					if (existing !== undefined) {
						existing.users++;
						return existing;
					}
					const created: Partition = {
						semaphore: yield* Semaphore.make(1),
						users: 1,
					};
					partitions.set(key, created);
					return created;
				}),
			);
		const releasePartition = (key: PartitionKey, partition: Partition) =>
			registry.withPermit(
				Effect.sync(() => {
					partition.users--;
					if (partition.users === 0 && partitions.get(key) === partition)
						partitions.delete(key);
				}),
			);
		const run = (task: Task<any, any>) =>
			Effect.gen(function* () {
				const partition = yield* acquirePartition(task.key);
				const exit = yield* Effect.exit(
					partition.semaphore.withPermit(
						global.withPermit(
							Effect.raceFirst(
								task.effect,
								Effect.andThen(
									Deferred.await(task.cancelled),
									Effect.interrupt,
								),
							),
						),
					),
				);
				yield* Deferred.done(task.result, exit);
				yield* releasePartition(task.key, partition);
				yield* Deferred.succeed(task.settled, undefined);
			}).pipe(
				Effect.ensuring(
					Deferred.succeed(task.settled, undefined).pipe(Effect.ignore),
				),
			);
		const intake = Stream.runForEach(Stream.fromQueue(queue), (task) =>
			Effect.asVoid(Effect.forkScoped(run(task))),
		);
		yield* Effect.forkScoped(intake);
		return {
			submit: (key, effect) =>
				Effect.acquireUseRelease(
					admission.take(1),
					() =>
						Effect.gen(function* () {
							const context = yield* Effect.context<any>();
							const result = yield* Deferred.make<any, any>();
							const cancelled = yield* Deferred.make<void>();
							const settled = yield* Deferred.make<void>();
							yield* Queue.offer(queue, {
								key,
								effect: Effect.provide(effect, context),
								result,
								cancelled,
								settled,
							});
							return yield* Deferred.await(result).pipe(
								Effect.onInterrupt(() =>
									Effect.andThen(
										Deferred.succeed(cancelled, undefined),
										Deferred.await(settled),
									).pipe(Effect.ignore),
								),
							);
						}),
					() => Effect.asVoid(admission.release(1)),
				) as never,
		};
	});

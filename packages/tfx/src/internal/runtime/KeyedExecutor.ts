import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
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
interface PreparedTask<A, E> extends Task<A, E> {
	readonly predecessor: Deferred.Deferred<void> | undefined;
	readonly successor: Deferred.Deferred<void>;
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
		const tails = new Map<PartitionKey, Deferred.Deferred<void>>();
		const tasks = new Set<Task<any, any>>();
		const run = (task: PreparedTask<any, any>) => {
			const awaitTurn =
				task.predecessor === undefined
					? Effect.void
					: Deferred.await(task.predecessor);
			const work = Effect.andThen(awaitTurn, global.withPermit(task.effect));
			return Effect.gen(function* () {
				const execution = yield* Effect.forkChild(work);
				const exit = yield* Effect.raceFirst(
					Fiber.await(execution),
					Effect.andThen(
						Deferred.await(task.cancelled),
						Effect.andThen(Fiber.interrupt(execution), Fiber.await(execution)),
					),
				);
				yield* Deferred.done(task.result, exit);
			}).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						yield* Deferred.interrupt(task.result);
						yield* Deferred.succeed(task.successor, undefined);
						yield* Effect.sync(() => {
							if (tails.get(task.key) === task.successor)
								tails.delete(task.key);
						});
						yield* admission.release(1);
						yield* Effect.sync(() => tasks.delete(task));
						yield* Deferred.succeed(task.settled, undefined);
					}),
				),
			);
		};
		const intake = Stream.runForEach(Stream.fromQueue(queue), (task) =>
			Effect.gen(function* () {
				const successor = Deferred.makeUnsafe<void>();
				const prepared: PreparedTask<any, any> = {
					...task,
					predecessor: tails.get(task.key),
					successor,
				};
				tails.set(task.key, successor);
				yield* Effect.forkScoped(run(prepared));
			}),
		);
		yield* Effect.forkScoped(intake);
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const pending = [...tasks];
				yield* Effect.forEach(pending, (task) =>
					Deferred.succeed(task.cancelled, undefined),
				);
				yield* Effect.forEach(pending, (task) => Deferred.await(task.settled));
			}),
		);
		return {
			submit: (key, effect) =>
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						yield* restore(admission.take(1));
						const context = yield* Effect.context<any>();
						const result = yield* Deferred.make<any, any>();
						const cancelled = yield* Deferred.make<void>();
						const settled = yield* Deferred.make<void>();
						const task: Task<any, any> = {
							key,
							effect: Effect.provide(effect, context),
							result,
							cancelled,
							settled,
						};
						tasks.add(task);
						yield* restore(Queue.offer(queue, task)).pipe(
							Effect.onInterrupt(() =>
								Effect.gen(function* () {
									tasks.delete(task);
									yield* admission.release(1);
									yield* Deferred.succeed(settled, undefined);
								}),
							),
						);
						return yield* restore(Deferred.await(result)).pipe(
							Effect.onInterrupt(() =>
								Effect.asVoid(Deferred.succeed(cancelled, undefined)),
							),
						);
					}),
				) as never,
		};
	});

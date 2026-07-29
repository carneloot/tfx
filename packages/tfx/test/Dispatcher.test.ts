import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
import * as KeyedExecutor from '../src/internal/runtime/KeyedExecutor.js';
import * as Router from '../src/internal/runtime/Router.js';
import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
const update = (value: object) => value as Update;
describe('Dispatcher', () => {
	it('executes one partition FIFO while unrelated partitions overlap', async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const executor = yield* KeyedExecutor.make({
					concurrency: 2,
					capacity: 3,
				});
				const firstStarted = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const secondStarted = yield* Deferred.make<void>();
				const otherStarted = yield* Deferred.make<void>();
				const first = yield* Effect.forkChild(
					executor.submit(
						'same',
						Effect.andThen(
							Deferred.succeed(firstStarted, undefined),
							Deferred.await(release),
						),
					),
				);
				yield* Deferred.await(firstStarted);
				const second = yield* Effect.forkChild(
					executor.submit('same', Deferred.succeed(secondStarted, undefined)),
				);
				const other = yield* Effect.forkChild(
					executor.submit('other', Deferred.succeed(otherStarted, undefined)),
				);
				yield* Deferred.await(otherStarted);
				expect(yield* Deferred.isDone(secondStarted)).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				yield* Fiber.join(other);
				expect(yield* Deferred.isDone(secondStarted)).toBe(true);
			}),
		);
		await Effect.runPromise(program);
	});
	it('relays a cancelled same-key slot without breaking FIFO', async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const executor = yield* KeyedExecutor.make({
					concurrency: 2,
					capacity: 2,
				});
				const firstStarted = yield* Deferred.make<void>();
				const releaseFirst = yield* Deferred.make<void>();
				const secondStarted = yield* Deferred.make<void>();
				const thirdStarted = yield* Deferred.make<void>();
				const first = yield* Effect.forkChild(
					executor.submit(
						'same',
						Effect.andThen(
							Deferred.succeed(firstStarted, undefined),
							Deferred.await(releaseFirst),
						),
					),
				);
				yield* Deferred.await(firstStarted);
				const second = yield* Effect.forkChild(
					executor.submit('same', Deferred.succeed(secondStarted, undefined)),
				);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(second);
				expect(yield* Deferred.isDone(secondStarted)).toBe(false);
				expect(yield* Deferred.isDone(firstStarted)).toBe(true);
				const third = yield* Effect.forkChild(
					executor.submit('same', Deferred.succeed(thirdStarted, undefined)),
				);
				yield* Effect.yieldNow;
				expect(yield* Deferred.isDone(thirdStarted)).toBe(false);
				yield* Deferred.succeed(releaseFirst, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(third);
				expect(yield* Deferred.isDone(thirdStarted)).toBe(true);
			}),
		);
		await Effect.runPromise(program);
	});

	it('preserves submission order under repeated same-key contention', async () => {
		const order = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const executor = yield* KeyedExecutor.make({
						concurrency: 8,
						capacity: 32,
					});
					const observed: Array<number> = [];
					const fibers: Array<Fiber.Fiber<void>> = [];
					for (let index = 0; index < 32; index++) {
						fibers.push(
							yield* Effect.forkChild(
								executor.submit(
									'same',
									Effect.sync(() => observed.push(index)).pipe(Effect.asVoid),
								),
							),
						);
						yield* Effect.yieldNow;
					}
					yield* Effect.forEach(fibers, Fiber.join);
					return observed;
				}),
			),
		);
		expect(order).toEqual(Array.from({ length: 32 }, (_, index) => index));
	});

	it('bounds admitted work and restores capacity after interruption', async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const executor = yield* KeyedExecutor.make({
					concurrency: 1,
					capacity: 1,
				});
				const started = yield* Deferred.make<void>();
				const finalized = yield* Deferred.make<void>();
				const blockedStarted = yield* Deferred.make<void>();
				const running = yield* Effect.forkChild(
					executor.submit(
						'one',
						Effect.andThen(
							Deferred.succeed(started, undefined),
							Effect.never,
						).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))),
					),
				);
				yield* Deferred.await(started);
				const blocked = yield* Effect.forkChild(
					executor.submit('two', Deferred.succeed(blockedStarted, undefined)),
				);
				yield* Effect.yieldNow;
				expect(yield* Deferred.isDone(blockedStarted)).toBe(false);
				yield* Fiber.interrupt(running);
				yield* Deferred.await(finalized);
				yield* Fiber.join(blocked);
				expect(yield* Deferred.isDone(blockedStarted)).toBe(true);
			}),
		);
		await Effect.runPromise(program);
	});

	it('interrupts admitted work during scope shutdown', async () => {
		const finalized = Deferred.makeUnsafe<void>();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const executor = yield* KeyedExecutor.make({
						concurrency: 1,
						capacity: 1,
					});
					const started = yield* Deferred.make<void>();
					yield* Effect.forkScoped(
						executor.submit(
							'one',
							Effect.andThen(
								Deferred.succeed(started, undefined),
								Effect.never,
							).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))),
						),
					);
					yield* Deferred.await(started);
				}),
			),
		);
		await Effect.runPromise(Effect.sleep('10 millis'));
		expect(await Effect.runPromise(Deferred.isDone(finalized))).toBe(true);
	});

	it('routes lifecycle, beforeConversation, conversation, command, callback, message, fallback in priority order', async () => {
		const calls: Array<string> = [];
		const handler =
			(
				name: string,
				result:
					| DispatchOutcome.DispatchOutcome
					| undefined = DispatchOutcome.handled,
			) =>
			(_update: Update) =>
				Effect.sync(() => {
					calls.push(name);
					return result;
				});
		const router = Router.make({
			lifecycle: handler('lifecycle') as never,
			beforeConversation: () =>
				Effect.sync(() => {
					calls.push('beforeConversation');
					return undefined;
				}),
			conversation: () =>
				Effect.sync(() => {
					calls.push('conversation');
					return undefined;
				}),
			command: () =>
				Effect.sync(() => {
					calls.push('command');
					return undefined;
				}),
			callback: handler('callback') as never,
			message: handler('message') as never,
			fallback: handler('fallback') as never,
		});
		await Effect.runPromise(
			router.route(update({ update_id: 1, my_chat_member: {} })),
		);
		await Effect.runPromise(
			router.route(
				update({ update_id: 2, message: { text: 'ordinary input' } }),
			),
		);
		await Effect.runPromise(
			router.route(update({ update_id: 3, callback_query: {} })),
		);
		await Effect.runPromise(
			router.route(update({ update_id: 4, message: {} })),
		);
		await Effect.runPromise(router.route(update({ update_id: 5, poll: {} })));
		expect(calls).toEqual([
			'lifecycle',
			'beforeConversation',
			'conversation',
			'command',
			'message',
			'beforeConversation',
			'conversation',
			'command',
			'callback',
			'beforeConversation',
			'conversation',
			'command',
			'message',
			'beforeConversation',
			'conversation',
			'command',
			'fallback',
		]);
	});
});

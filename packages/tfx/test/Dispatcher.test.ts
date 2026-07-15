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
					capacity: 2,
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
	it('routes lifecycle, cancel, conversation, command, callback, message, fallback in priority order', async () => {
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
			cancel: handler('cancel') as never,
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
			router.route(update({ update_id: 2, message: { text: '/cancelar' } })),
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
			'cancel',
			'conversation',
			'command',
			'callback',
			'conversation',
			'command',
			'message',
			'conversation',
			'command',
			'fallback',
		]);
	});
});

import { Deferred, Duration, Effect, Fiber, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as PollingSource from '../src/internal/update-source/PollingSource.js';
import type { TelegramService } from '../src/Telegram.js';
import {
	NetworkError,
	RateLimitError,
	TelegramError,
	type TelegramErrorReason,
} from '../src/TelegramError.js';

const telegramError = (reason: TelegramErrorReason): TelegramError =>
	new TelegramError({ module: 'Telegram', method: 'getUpdates', reason });
describe('Polling', () => {
	it('publishes startup/menu before polling and advances only contiguous acknowledged offsets', async () => {
		const calls: Array<{
			readonly method: string;
			readonly payload?: unknown;
		}> = [];
		let polls = 0;
		const terminal = {
			reason: { _tag: 'AuthenticationError' },
		} as TelegramError;
		const telegram = {
			getMe: () =>
				Effect.sync(() => {
					calls.push({ method: 'getMe' });
					return { id: 1 };
				}),
			deleteWebhook: (payload: unknown) =>
				Effect.sync(() => {
					calls.push({ method: 'deleteWebhook', payload });
					return true;
				}),
			setMyCommands: (payload: unknown) =>
				Effect.sync(() => {
					calls.push({ method: 'setMyCommands', payload });
					return true;
				}),
			getUpdates: (payload: unknown) =>
				Effect.suspend(() => {
					calls.push({ method: 'getUpdates', payload });
					polls++;
					return polls === 1
						? Effect.succeed([
								{ update_id: 1 },
								{ update_id: 2 },
								{ update_id: 3 },
							] as ReadonlyArray<Update>)
						: Effect.fail(terminal);
				}),
		} as unknown as TelegramService;
		const source = PollingSource.make(telegram, {
			commands: [{ command: 'start', description: 'Start' }],
			allowedUpdates: ['message'],
			timeout: Duration.seconds(30),
			retryDelay: Duration.seconds(1),
		});
		await expect(
			Effect.runPromise(
				source.run((item) =>
					Effect.succeed(
						item.update_id === 2
							? DispatchOutcome.retryableFailure('retry')
							: DispatchOutcome.handled,
					),
				) as Effect.Effect<void, unknown>,
			),
		).rejects.toBe(terminal);
		expect(calls.map((call) => call.method)).toEqual([
			'getMe',
			'deleteWebhook',
			'setMyCommands',
			'getUpdates',
			'getUpdates',
		]);
		expect(calls[1]?.payload).toEqual({ drop_pending_updates: false });
		expect(calls[2]?.payload).toEqual({
			commands: [{ command: 'start', description: 'Start' }],
			language_code: 'pt',
		});
		expect(calls[3]?.payload).toMatchObject({
			timeout: 30,
			allowed_updates: ['message'],
		});
		expect(calls[4]?.payload).toMatchObject({ offset: 2 });
		expect(calls[4]?.payload).not.toHaveProperty('allowed_updates');
	});

	it('reinvokes getUpdates for retries and omits allowed updates after first success', async () => {
		const program = Effect.gen(function* () {
			const requests: Array<Record<string, unknown>> = [];
			const invocations = [
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
			];
			const failure = telegramError(new NetworkError({ message: 'offline' }));
			const terminal = {
				reason: { _tag: 'AuthenticationError' },
			} as TelegramError;
			const telegram = {
				getMe: () => Effect.succeed({ id: 1 }),
				deleteWebhook: () => Effect.succeed(true),
				getUpdates: (request: Record<string, unknown>) => {
					requests.push(request);
					const attempt = requests.length;
					const result =
						attempt <= 2
							? Effect.fail(failure)
							: attempt === 3
								? Effect.succeed([{ update_id: 10 }] as ReadonlyArray<Update>)
								: Effect.fail(terminal);
					return Deferred.succeed(invocations[attempt - 1]!, undefined).pipe(
						Effect.andThen(result),
					);
				},
			} as unknown as TelegramService;
			const source = PollingSource.make(telegram, {
				allowedUpdates: ['message'],
				timeout: Duration.seconds(30),
				retryDelay: Duration.millis(25),
			});
			yield* Effect.forkChild(
				source.run(() => Effect.succeed(DispatchOutcome.handled)),
			);
			yield* Deferred.await(invocations[0]!);
			expect(requests).toHaveLength(1);
			yield* Effect.yieldNow;
			yield* TestClock.adjust('24 millis');
			expect(requests).toHaveLength(1);
			yield* TestClock.adjust('26 millis');
			expect(requests).toHaveLength(4);
			expect(requests.slice(0, 3)).toEqual(
				requests.slice(0, 3).map((request) => ({
					...request,
					allowed_updates: ['message'],
				})),
			);
			expect(requests[3]).toMatchObject({ offset: 11 });
			expect(requests[3]).not.toHaveProperty('allowed_updates');
		});
		await Effect.runPromise(Effect.provide(program, TestClock.layer()));
	});

	it('retries rate limits after provider retry delay', async () => {
		const program = Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const firstAttempt = yield* Deferred.make<void>();
			const failure = telegramError(
				new RateLimitError({
					errorCode: 429,
					description: 'Too Many Requests',
					retryAfterSeconds: 2,
				}),
			);
			const telegram = {
				getMe: () => Effect.succeed({ id: 1 }),
				deleteWebhook: () => Effect.succeed(true),
				getUpdates: () =>
					Ref.updateAndGet(attempts, (count) => count + 1).pipe(
						Effect.tap((count) =>
							count === 1
								? Deferred.succeed(firstAttempt, undefined)
								: Effect.void,
						),
						Effect.andThen(Effect.fail(failure)),
					),
			} as unknown as TelegramService;
			const source = PollingSource.make(telegram, {
				timeout: Duration.seconds(30),
				retryDelay: Duration.millis(25),
			});
			const fiber = yield* Effect.forkChild(
				source.run(() => Effect.succeed(DispatchOutcome.handled)),
			);
			yield* Deferred.await(firstAttempt);
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust('1999 millis');
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust('1 millis');
			expect(yield* Ref.get(attempts)).toBe(2);
			yield* Fiber.interrupt(fiber);
		});
		await Effect.runPromise(Effect.provide(program, TestClock.layer()));
	});
});

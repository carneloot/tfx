import {
	Deferred,
	Duration,
	Effect,
	Fiber,
	Logger,
	Random,
	Ref,
	References,
} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as PollingSource from '../src/internal/update-source/PollingSource.js';
import * as Polling from '../src/Polling.js';
import type { TelegramService } from '../src/Telegram.js';
import {
	NetworkError,
	RateLimitError,
	TelegramError,
	type TelegramErrorReason,
} from '../src/TelegramError.js';

const telegramError = (reason: TelegramErrorReason): TelegramError =>
	new TelegramError({ module: 'Telegram', method: 'getUpdates', reason });
interface CapturedLog {
	readonly message: unknown;
	readonly level: string;
	readonly annotations: Readonly<Record<string, unknown>>;
}
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<CapturedLog> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			level: options.logLevel,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.map(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		(result) => ({ result, logs }),
	);
};
describe('Polling', () => {
	it.each([
		['invalid timeout', { timeout: 'not a duration' as Duration.Input }],
		['zero timeout', { timeout: Duration.zero }],
		['sub-second timeout', { timeout: Duration.millis(999) }],
		['negative timeout', { timeout: Duration.millis(-1) }],
		['infinite timeout', { timeout: Duration.infinity }],
		['timeout above maximum', { timeout: Duration.seconds(51) }],
		['invalid retry delay', { retryDelay: 'not a duration' as Duration.Input }],
		['zero retry delay', { retryDelay: Duration.zero }],
		['negative retry delay', { retryDelay: Duration.millis(-1) }],
		['infinite retry delay', { retryDelay: Duration.infinity }],
		['zero limit', { limit: 0 }],
		['fractional limit', { limit: 1.5 }],
		['limit above maximum', { limit: 101 }],
	])('rejects %s', (_name, options) => {
		expect(() => Polling.make(options)).toThrow(TypeError);
	});

	it.each([
		{ timeout: Duration.seconds(1), retryDelay: Duration.millis(1), limit: 1 },
		{
			timeout: Duration.seconds(50),
			retryDelay: Duration.seconds(1),
			limit: 100,
		},
	])('accepts valid polling boundaries %#', (options) => {
		expect(() => Polling.make(options)).not.toThrow();
	});

	it('publishes startup/menu before polling and advances acknowledged offsets', async () => {
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
		const captured = await Effect.runPromise(
			captureLogs(
				Effect.result(
					source.run((item) =>
						Effect.succeed(
							item.update_id === 2
								? DispatchOutcome.permanentInvalid('invalid')
								: DispatchOutcome.handled,
						),
					) as Effect.Effect<void, unknown>,
				),
			),
		);
		expect(captured.result).toMatchObject({
			_tag: 'Failure',
			failure: terminal,
		});
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
		expect(calls[4]?.payload).toMatchObject({ offset: 4 });
		expect(calls[4]?.payload).not.toHaveProperty('allowed_updates');
		const batchLogs = captured.logs.filter(
			(log) =>
				log.message === 'tfx.polling.batch_received' ||
				log.message === 'tfx.polling.batch_acknowledged',
		);
		expect(batchLogs).toEqual([
			{
				message: 'tfx.polling.batch_received',
				level: 'Info',
				annotations: { received: 3 },
			},
			{
				message: 'tfx.polling.batch_acknowledged',
				level: 'Info',
				annotations: { received: 3, acknowledged: 3, nextOffset: 4 },
			},
		]);
	});

	it('reinvokes getUpdates, resets backoff, and omits allowed updates after first success', async () => {
		const program = Effect.gen(function* () {
			const requests: Array<Record<string, unknown>> = [];
			const invocations = [
				yield* Deferred.make<void>(),
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
						attempt <= 2 || attempt === 4
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
			yield* TestClock.adjust('1 millis');
			yield* Deferred.await(invocations[1]!);
			expect(requests).toHaveLength(2);
			yield* TestClock.adjust('49 millis');
			expect(requests).toHaveLength(2);
			yield* TestClock.adjust('1 millis');
			yield* Deferred.await(invocations[2]!);
			yield* Deferred.await(invocations[3]!);
			expect(requests).toHaveLength(4);
			yield* TestClock.adjust('24 millis');
			expect(requests).toHaveLength(4);
			yield* TestClock.adjust('1 millis');
			yield* Deferred.await(invocations[4]!);
			expect(requests).toHaveLength(5);
			expect(requests.slice(0, 3)).toEqual(
				requests.slice(0, 3).map((request) => ({
					...request,
					allowed_updates: ['message'],
				})),
			);
			for (const request of requests.slice(3)) {
				expect(request).toMatchObject({ offset: 11 });
				expect(request).not.toHaveProperty('allowed_updates');
			}
		});
		await Effect.runPromise(
			Effect.provide(program, TestClock.layer()).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.5,
				}),
			),
		);
	});

	it('backs off retries through 1, 2, 4, 8, 15, and 30 times the initial delay', async () => {
		const program = Effect.gen(function* () {
			let attempts = 0;
			const invocations = [
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
			];
			const failure = telegramError(new NetworkError({ message: 'offline' }));
			const telegram = {
				getMe: () => Effect.succeed({ id: 1 }),
				deleteWebhook: () => Effect.succeed(true),
				getUpdates: () => {
					const attempt = attempts++;
					return Deferred.succeed(invocations[attempt]!, undefined).pipe(
						Effect.andThen(Effect.fail(failure)),
					);
				},
			} as unknown as TelegramService;
			const source = PollingSource.make(telegram, {
				timeout: Duration.seconds(30),
				retryDelay: Duration.millis(20),
			});
			const fiber = yield* Effect.forkChild(
				source.run(() => Effect.succeed(DispatchOutcome.handled)),
			);
			yield* Deferred.await(invocations[0]!);
			for (const [index, delay] of [20, 40, 80, 160, 300, 600, 600].entries()) {
				yield* TestClock.adjust(Duration.millis(delay - 1));
				expect(attempts).toBe(index + 1);
				yield* TestClock.adjust(Duration.millis(1));
				yield* Deferred.await(invocations[index + 1]!);
				expect(attempts).toBe(index + 2);
			}
			yield* Fiber.interrupt(fiber);
		});
		await Effect.runPromise(
			Effect.provide(program, TestClock.layer()).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.5,
				}),
			),
		);
	});

	it('backs off and jitters retryable dispatches without polling again, then resets', async () => {
		const program = Effect.gen(function* () {
			let polls = 0;
			let firstUpdateAttempts = 0;
			let secondUpdateAttempts = 0;
			const firstUpdateInvocations = [
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
			];
			const secondUpdateInvocations = [
				yield* Deferred.make<void>(),
				yield* Deferred.make<void>(),
			];
			const terminal = {
				reason: { _tag: 'AuthenticationError' },
			} as TelegramError;
			const telegram = {
				getMe: () => Effect.succeed({ id: 1 }),
				deleteWebhook: () => Effect.succeed(true),
				getUpdates: () => {
					polls++;
					return polls === 1
						? Effect.succeed([{ update_id: 1 }] as ReadonlyArray<Update>)
						: polls === 2
							? Effect.succeed([{ update_id: 2 }] as ReadonlyArray<Update>)
							: Effect.fail(terminal);
				},
			} as unknown as TelegramService;
			const source = PollingSource.make(telegram, {
				timeout: Duration.seconds(30),
				retryDelay: Duration.millis(20),
			});
			const fiber = yield* Effect.forkChild(
				source.run((update) => {
					if (update.update_id === 1) {
						const attempt = firstUpdateAttempts++;
						return Deferred.succeed(
							firstUpdateInvocations[attempt]!,
							undefined,
						).pipe(
							Effect.as(
								attempt === 7
									? DispatchOutcome.handled
									: DispatchOutcome.retryableFailure('retry'),
							),
						);
					}
					const attempt = secondUpdateAttempts++;
					return Deferred.succeed(
						secondUpdateInvocations[attempt]!,
						undefined,
					).pipe(
						Effect.as(
							attempt === 1
								? DispatchOutcome.handled
								: DispatchOutcome.retryableFailure('retry'),
						),
					);
				}),
			);
			yield* Deferred.await(firstUpdateInvocations[0]!);
			expect(polls).toBe(1);
			for (const [index, delay] of [22, 44, 88, 176, 330, 660, 660].entries()) {
				yield* TestClock.adjust(Duration.millis(delay - 1));
				expect(firstUpdateAttempts).toBe(index + 1);
				expect(polls).toBe(1);
				yield* TestClock.adjust(Duration.millis(1));
				yield* Deferred.await(firstUpdateInvocations[index + 1]!);
				expect(firstUpdateAttempts).toBe(index + 2);
			}
			yield* Deferred.await(secondUpdateInvocations[0]!);
			expect(polls).toBe(2);
			yield* TestClock.adjust('21 millis');
			expect(secondUpdateAttempts).toBe(1);
			yield* TestClock.adjust('1 millis');
			yield* Deferred.await(secondUpdateInvocations[1]!);
			expect(secondUpdateAttempts).toBe(2);
			yield* Fiber.interrupt(fiber);
		});
		await Effect.runPromise(
			Effect.provide(program, TestClock.layer()).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.75,
				}),
			),
		);
	});

	it('stops retrying siblings when a concurrent dispatch is fatal', async () => {
		const retryStarted = await Effect.runPromise(Deferred.make<void>());
		const telegram = {
			getMe: () => Effect.succeed({ id: 1 }),
			deleteWebhook: () => Effect.succeed(true),
			getUpdates: () =>
				Effect.succeed([
					{ update_id: 1 },
					{ update_id: 2 },
				] as ReadonlyArray<Update>),
		} as unknown as TelegramService;
		const source = PollingSource.make(telegram, {
			timeout: Duration.seconds(30),
			retryDelay: Duration.seconds(1),
		});
		const captured = await Effect.runPromise(
			captureLogs(
				Effect.result(
					source.run((update) =>
						update.update_id === 1
							? Deferred.succeed(retryStarted, undefined).pipe(
									Effect.as(DispatchOutcome.retryableFailure('retry')),
								)
							: Deferred.await(retryStarted).pipe(
									Effect.as(DispatchOutcome.fatal('fatal')),
								),
					),
				),
			),
		);
		expect(captured.result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'FatalPollingDispatchError',
				updateId: 2,
			},
		});
		expect(
			captured.logs.some(
				(log) =>
					log.message === 'tfx.polling.dispatch_fatal' &&
					log.annotations.updateId === 2,
			),
		).toBe(true);
	});

	it('jitters fallback retry delays', async () => {
		const program = Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const firstAttempt = yield* Deferred.make<void>();
			const secondAttempt = yield* Deferred.make<void>();
			const failure = telegramError(new NetworkError({ message: 'offline' }));
			const terminal = {
				reason: { _tag: 'AuthenticationError' },
			} as TelegramError;
			const telegram = {
				getMe: () => Effect.succeed({ id: 1 }),
				deleteWebhook: () => Effect.succeed(true),
				getUpdates: () =>
					Ref.updateAndGet(attempts, (count) => count + 1).pipe(
						Effect.tap((count) =>
							Deferred.succeed(
								count === 1 ? firstAttempt : secondAttempt,
								undefined,
							),
						),
						Effect.andThen((count) =>
							count === 1 ? Effect.fail(failure) : Effect.fail(terminal),
						),
					),
			} as unknown as TelegramService;
			const source = PollingSource.make(telegram, {
				timeout: Duration.seconds(30),
				retryDelay: Duration.millis(100),
			});
			yield* Effect.forkChild(
				source.run(() => Effect.succeed(DispatchOutcome.handled)),
			);
			yield* Deferred.await(firstAttempt);
			yield* TestClock.adjust('109 millis');
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust('1 millis');
			yield* Deferred.await(secondAttempt);
			expect(yield* Ref.get(attempts)).toBe(2);
		});
		await Effect.runPromise(
			Effect.provide(program, TestClock.layer()).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.75,
				}),
			),
		);
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
		await Effect.runPromise(
			Effect.provide(program, TestClock.layer()).pipe(
				Effect.provideService(Random.Random, {
					nextIntUnsafe: () => 0,
					nextDoubleUnsafe: () => 0.75,
				}),
			),
		);
	});
});

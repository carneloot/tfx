import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as PollingSource from '../src/internal/update-source/PollingSource.js';
import type { TelegramService } from '../src/Telegram.js';
import type { TelegramError } from '../src/TelegramError.js';
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
});

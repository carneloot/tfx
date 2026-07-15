import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';

import { safeMessage } from '../src/internal/telegram/Sanitize.js';
import {
	InvalidResponseError,
	NetworkError,
	TelegramError,
	fromEnvelope,
} from '../src/TelegramError.js';

const cases = [
	[401, 'AuthenticationError', false],
	[403, 'ForbiddenError', false],
	[400, 'InvalidRequestError', false],
	[409, 'ConflictError', true],
	[500, 'InternalTelegramError', true],
] as const;

describe('TelegramError', () => {
	it.each(cases)('maps %i', (code, tag, retryable) => {
		const error = fromEnvelope('sendMessage', {
			ok: false,
			error_code: code,
			description: 'safe',
		});
		expect(error).toMatchObject({
			_tag: 'TelegramError',
			module: 'Telegram',
			method: 'sendMessage',
			reason: { _tag: tag },
			isRetryable: retryable,
		});
	});
	it('maps unknown failures and redacts tokens', () => {
		expect(
			fromEnvelope('call', { ok: false, error_code: 418 }).reason._tag,
		).toBe('UnknownError');
		const network = new TelegramError({
			module: 'Telegram',
			method: 'getMe',
			reason: new NetworkError({
				message: safeMessage('https://api.telegram.org/bot123456:secret/getMe'),
			}),
		});
		expect(String(network.reason.message)).not.toContain('123456:secret');
		expect(
			new InvalidResponseError({ message: 'Invalid envelope' }).isRetryable,
		).toBe(false);
	});
	it('preserves rate limit and migration parameters', () => {
		const rate = fromEnvelope('getUpdates', {
			ok: false,
			error_code: 429,
			parameters: { retry_after: 12 },
		});
		expect(Duration.toSeconds(rate.retryAfter!)).toBe(12);
		const migrated = fromEnvelope('sendMessage', {
			ok: false,
			error_code: 400,
			parameters: { migrate_to_chat_id: -1001 },
		});
		expect(migrated.reason).toMatchObject({
			_tag: 'ChatMigrationError',
			migrateToChatId: -1001,
		});
	});
});

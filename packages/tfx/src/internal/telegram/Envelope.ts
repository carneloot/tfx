import * as Effect from 'effect/Effect';

import {
	InvalidResponseError,
	TelegramError,
	fromEnvelope,
} from '../../TelegramError.js';

export const decodeEnvelope = (
	method: string,
	input: unknown,
): Effect.Effect<unknown, TelegramError> => {
	if (typeof input !== 'object' || input === null || !('ok' in input)) {
		return Effect.fail(
			new TelegramError({
				module: 'Telegram',
				method,
				reason: new InvalidResponseError({
					message: 'Invalid Telegram response envelope',
				}),
			}),
		);
	}
	const envelope = input as Record<string, unknown>;
	if (envelope.ok === true && 'result' in envelope)
		return Effect.succeed(envelope.result);
	if (envelope.ok === false && typeof envelope.error_code === 'number')
		return Effect.fail(fromEnvelope(method, envelope as never));
	return Effect.fail(
		new TelegramError({
			module: 'Telegram',
			method,
			reason: new InvalidResponseError({
				message: 'Invalid Telegram response envelope',
			}),
		}),
	);
};

import type * as DateTime from 'effect/DateTime';
import * as Schema from 'effect/Schema';

import { BotId } from '../Ids.js';

export const SafeError = Schema.Struct({
	code: Schema.optionalKey(Schema.String),
	message: Schema.String,
});
export type SafeError = typeof SafeError.Type;
const SafeMessageId = Schema.Number.check(
	Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
		message: 'Expected a positive safe Telegram message ID',
	}),
);
export const DeliveryOutcome = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal('Sent'),
		telegramBotId: BotId,
		telegramMessageId: SafeMessageId,
	}),
	Schema.Struct({
		_tag: Schema.Literal('Failed'),
		error: SafeError,
		retryable: Schema.Boolean,
		retryAt: Schema.NullOr(Schema.DateTimeUtc),
	}),
	Schema.Struct({ _tag: Schema.Literal('Unknown'), error: SafeError }),
]);
export type DeliveryOutcome = typeof DeliveryOutcome.Type;
export const sent = (
	telegramBotId: BotId,
	telegramMessageId: number,
): DeliveryOutcome => ({ _tag: 'Sent', telegramBotId, telegramMessageId });
export const failed = (
	error: SafeError,
	retryable: boolean,
	retryAt: DateTime.Utc | null,
): DeliveryOutcome => ({ _tag: 'Failed', error, retryable, retryAt });
export const unknown = (error: SafeError): DeliveryOutcome => ({
	_tag: 'Unknown',
	error,
});

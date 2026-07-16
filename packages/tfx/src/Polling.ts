import * as Duration from 'effect/Duration';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import * as PollingSource from './internal/update-source/PollingSource.js';
import { UpdateSource } from './internal/update-source/UpdateSource.js';
import * as UpdateDelivery from './UpdateDelivery.js';
export interface Options extends PollingSource.PollingOptions {
	readonly id?: string;
}
const pollingLimit = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 100 }),
);
const isPollingLimit = Schema.is(pollingLimit);
const normalizeDuration = (input: Duration.Input, name: string) =>
	Option.getOrThrowWith(
		Duration.fromInput(input),
		() => new TypeError(`${name} is not a valid Duration input`),
	);
const allowed = new Set([
	'message',
	'edited_message',
	'channel_post',
	'edited_channel_post',
	'business_connection',
	'business_message',
	'edited_business_message',
	'deleted_business_messages',
	'message_reaction',
	'message_reaction_count',
	'inline_query',
	'chosen_inline_result',
	'callback_query',
	'shipping_query',
	'pre_checkout_query',
	'purchased_paid_media',
	'poll',
	'poll_answer',
	'my_chat_member',
	'chat_member',
	'chat_join_request',
	'chat_boost',
	'removed_chat_boost',
]);
export const make = (options: Options = {}) => {
	if (options.allowedUpdates !== undefined) {
		const seen = new Set<string>();
		for (const value of options.allowedUpdates) {
			if (!allowed.has(value))
				throw new TypeError(`Unknown allowed update '${value}'`);
			if (seen.has(value))
				throw new TypeError(`Duplicate allowed update '${value}'`);
			seen.add(value);
		}
	}
	const timeout = normalizeDuration(options.timeout ?? '30 seconds', 'timeout');
	if (
		Duration.isZero(timeout) ||
		Duration.isNegative(timeout) ||
		!Duration.isFinite(timeout) ||
		Duration.isLessThan(timeout, Duration.seconds(1)) ||
		Duration.isGreaterThan(timeout, Duration.seconds(50))
	)
		throw new TypeError('Polling timeout must be between 1 and 50 seconds');
	const retryDelay = normalizeDuration(
		options.retryDelay ?? '1 second',
		'retryDelay',
	);
	if (
		Duration.isZero(retryDelay) ||
		Duration.isNegative(retryDelay) ||
		!Duration.isFinite(retryDelay)
	)
		throw new TypeError('retryDelay must be finite and positive');
	if (options.limit !== undefined && !isPollingLimit(options.limit))
		throw new TypeError('Polling limit must be an integer between 1 and 100');
	return UpdateDelivery.make({
		id: options.id ?? 'polling',
		layer: Layer.effect(
			UpdateSource,
			PollingSource.fromContext({ ...options, timeout, retryDelay }),
		),
	});
};
export type { PollingOptions } from './internal/update-source/PollingSource.js';

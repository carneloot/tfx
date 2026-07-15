import * as Layer from 'effect/Layer';

import * as PollingSource from './internal/update-source/PollingSource.js';
import { UpdateSource } from './internal/update-source/UpdateSource.js';
import * as UpdateDelivery from './UpdateDelivery.js';
export interface Options extends PollingSource.PollingOptions {
	readonly id?: string;
}
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
	if ((options.timeout ?? 30) <= 0)
		throw new TypeError('Polling timeout must be positive');
	return UpdateDelivery.make({
		id: options.id ?? 'polling',
		layer: Layer.effect(UpdateSource, PollingSource.fromContext(options)),
	});
};
export type { PollingOptions } from './internal/update-source/PollingSource.js';

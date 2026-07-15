import { describe, expect, it } from 'vitest';

import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as UpdateRoutingScope from '../src/UpdateRoutingScope.js';
const update = (value: object) => value as Update;
describe('UpdateRoutingScope', () => {
	it.each([
		[
			{ update_id: 1, message: { chat: { id: 10 }, from: { id: 20 } } },
			{ _tag: 'ChatUser', chatId: 10, userId: 20 },
		],
		[
			{ update_id: 2, edited_channel_post: { chat: { id: -10 } } },
			{ _tag: 'Chat', chatId: -10 },
		],
		[
			{
				update_id: 3,
				callback_query: { from: { id: 20 }, message: { chat: { id: 10 } } },
			},
			{ _tag: 'ChatUser', chatId: 10, userId: 20 },
		],
		[
			{
				update_id: 4,
				callback_query: { from: { id: 20 }, inline_message_id: 'x' },
			},
			{ _tag: 'User', userId: 20 },
		],
		[
			{ update_id: 5, inline_query: { from: { id: 20 } } },
			{ _tag: 'User', userId: 20 },
		],
		[
			{ update_id: 6, business_connection: { id: 'bc' } },
			{ _tag: 'BusinessConnection', businessConnectionId: 'bc' },
		],
		[{ update_id: 7, poll: { id: 'p' } }, { _tag: 'Update' }],
	])('normalizes update %#', (raw, expected) =>
		expect(UpdateRoutingScope.fromUpdate('bot', update(raw))).toMatchObject({
			botId: 'bot',
			updateId: raw.update_id,
			...expected,
		}),
	);
	it('only exposes conversation identity for chat-user scope', () => {
		expect(
			UpdateRoutingScope.conversationScope(
				UpdateRoutingScope.fromUpdate(
					'bot',
					update({
						update_id: 1,
						message: { chat: { id: 1 }, from: { id: 2 } },
					}),
				),
			),
		).toEqual({ botId: 'bot', chatId: 1, userId: 2 });
		expect(
			UpdateRoutingScope.conversationScope(
				UpdateRoutingScope.fromUpdate(
					'bot',
					update({ update_id: 2, inline_query: { from: { id: 2 } } }),
				),
			),
		).toBeUndefined();
	});
});

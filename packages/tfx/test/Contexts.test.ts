import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import * as CallbackQueryContext from '../src/CallbackQueryContext.js';
import type {
	Message,
	Update,
} from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as MessageContext from '../src/MessageContext.js';
import { Telegram, type TelegramService } from '../src/Telegram.js';
import * as UpdateContext from '../src/UpdateContext.js';

const run = async (
	effects: ReadonlyArray<Effect.Effect<unknown, unknown, Telegram>>,
) => {
	const requests: Array<readonly [string, unknown]> = [];
	const telegram = new Proxy(
		{},
		{
			get: (_target, method: string) => (payload: unknown) => {
				requests.push([method, payload]);
				return Effect.succeed(true);
			},
		},
	) as TelegramService;
	await Effect.runPromise(
		Effect.provideService(Effect.all(effects), Telegram, telegram),
	);
	return requests;
};

const message = {
	message_id: 7,
	message_thread_id: 11,
	business_connection_id: 'business-1',
	date: 1,
	chat: { id: 42, type: 'private' },
	from: { id: 9, is_bot: false, first_name: 'Ada' },
} as Message;

describe('contextual Telegram helpers', () => {
	it('normalizes update identifiers', () => {
		const update = { update_id: 3, message } as Update;
		expect(UpdateContext.make(update)).toMatchObject({
			update,
			updateId: 3,
			userId: 9,
			chatId: 42,
		});
	});

	it('delegates message helpers with thread and business context', async () => {
		const context = MessageContext.make(message);
		const requests = await run([
			context.reply('oi', { disable_notification: true }),
			context.replyToCurrent('sim'),
			context.react([{ type: 'emoji', emoji: '👍' }]),
			context.editText('novo'),
			context.delete(),
			context.sendChatAction('typing'),
		]);
		expect(requests).toEqual([
			[
				'sendMessage',
				{
					disable_notification: true,
					chat_id: 42,
					message_thread_id: 11,
					business_connection_id: 'business-1',
					text: 'oi',
				},
			],
			[
				'sendMessage',
				{
					chat_id: 42,
					message_thread_id: 11,
					business_connection_id: 'business-1',
					text: 'sim',
					reply_parameters: { message_id: 7 },
				},
			],
			[
				'setMessageReaction',
				{
					chat_id: 42,
					message_id: 7,
					reaction: [{ type: 'emoji', emoji: '👍' }],
				},
			],
			[
				'editMessageText',
				{
					chat_id: 42,
					message_id: 7,
					business_connection_id: 'business-1',
					text: 'novo',
				},
			],
			['deleteMessage', { chat_id: 42, message_id: 7 }],
			[
				'sendChatAction',
				{
					chat_id: 42,
					message_thread_id: 11,
					business_connection_id: 'business-1',
					action: 'typing',
				},
			],
		]);
	});

	it('returns a typed error when deleting an inline callback message', async () => {
		const context = CallbackQueryContext.make({
			id: 'inline-1',
			from: message.from,
			chat_instance: 'instance',
			inline_message_id: 'inline-message',
		} as NonNullable<Update['callback_query']>);
		await expect(
			Effect.runPromise(
				Effect.provideService(
					Effect.flip(context.deleteMessage()),
					Telegram,
					{} as TelegramService,
				),
			),
		).resolves.toMatchObject({ reason: 'InlineMessageCannotBeDeleted' });
	});

	it('delegates callback helpers', async () => {
		const callback = {
			id: 'callback-1',
			from: message.from,
			chat_instance: 'instance',
			data: 'pick:1',
			message,
		} as NonNullable<Update['callback_query']>;
		const context = CallbackQueryContext.make(callback);
		expect(context.data).toBe('pick:1');
		expect(
			await run([
				context.answer({ text: 'ok' }),
				context.editMessageText('chosen'),
				context.deleteMessage(),
			]),
		).toEqual([
			['answerCallbackQuery', { text: 'ok', callback_query_id: 'callback-1' }],
			[
				'editMessageText',
				{
					chat_id: 42,
					message_id: 7,
					business_connection_id: 'business-1',
					text: 'chosen',
				},
			],
			['deleteMessage', { chat_id: 42, message_id: 7 }],
		]);
	});
});

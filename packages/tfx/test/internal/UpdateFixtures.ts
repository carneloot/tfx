import type { Update } from '../../src/internal/telegram/generated/TelegramApi.types.js';
const user = (id = 20) => ({ id, is_bot: false, first_name: `User ${id}` });
const chat = (id = 10) =>
	id < 0
		? { id, type: 'supergroup' as const, title: `Chat ${id}` }
		: { id, type: 'private' as const, first_name: `Chat ${id}` };
const messageBase = (id: number, chatId: number, userId: number) => ({
	message_id: id,
	date: 1_700_000_000,
	chat: chat(chatId),
	from: user(userId),
});
export const text = (
	value: string,
	options: {
		readonly updateId?: number;
		readonly chatId?: number;
		readonly userId?: number;
	} = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		message: {
			...messageBase(
				options.updateId ?? 1,
				options.chatId ?? 10,
				options.userId ?? 20,
			),
			text: value,
		},
	}) as Update;
export const command = (
	name: string,
	options: {
		readonly updateId?: number;
		readonly chatId?: number;
		readonly userId?: number;
		readonly botUsername?: string;
	} = {},
): Update => {
	const token = `/${name}${options.botUsername === undefined ? '' : `@${options.botUsername}`}`;
	return {
		update_id: options.updateId ?? 1,
		message: {
			...messageBase(
				options.updateId ?? 1,
				options.chatId ?? 10,
				options.userId ?? 20,
			),
			text: token,
			entities: [{ type: 'bot_command', offset: 0, length: token.length }],
		},
	} as Update;
};
export const callback = (
	data: string,
	options: {
		readonly updateId?: number;
		readonly chatId?: number;
		readonly userId?: number;
		readonly withMessage?: boolean;
	} = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		callback_query: {
			id: `callback-${options.updateId ?? 1}`,
			from: user(options.userId ?? 20),
			chat_instance: 'instance',
			data,
			...(options.withMessage === false
				? { inline_message_id: 'inline' }
				: {
						message: {
							message_id: options.updateId ?? 1,
							date: 0,
							chat: chat(options.chatId ?? 10),
						},
					}),
		},
	}) as Update;
export const reaction = (
	emoji: string,
	options: {
		readonly updateId?: number;
		readonly chatId?: number;
		readonly userId?: number;
	} = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		message_reaction: {
			chat: chat(options.chatId ?? 10),
			message_id: 1,
			date: 1_700_000_000,
			user: user(options.userId ?? 20),
			old_reaction: [],
			new_reaction: [{ type: 'emoji', emoji }],
		},
	}) as Update;
export const inline = (
	query: string,
	options: { readonly updateId?: number; readonly userId?: number } = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		inline_query: {
			id: `inline-${options.updateId ?? 1}`,
			from: user(options.userId ?? 20),
			query,
			offset: '',
		},
	}) as Update;
export const channel = (
	value: string,
	options: { readonly updateId?: number; readonly chatId?: number } = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		channel_post: {
			...messageBase(options.updateId ?? 1, options.chatId ?? -10, 20),
			text: value,
		},
	}) as Update;
export const business = (
	value: string,
	options: {
		readonly updateId?: number;
		readonly chatId?: number;
		readonly userId?: number;
	} = {},
): Update =>
	({
		update_id: options.updateId ?? 1,
		business_message: {
			...messageBase(
				options.updateId ?? 1,
				options.chatId ?? 10,
				options.userId ?? 20,
			),
			business_connection_id: 'business',
			text: value,
		},
	}) as Update;

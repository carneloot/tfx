import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';

import type { Message } from './internal/telegram/generated/TelegramApi.types.js';
import { Telegram, type TelegramService } from './Telegram.js';

type Payload<Method extends keyof TelegramService> = NonNullable<
	Parameters<TelegramService[Method]>[0]
>;
type Options<
	Method extends keyof TelegramService,
	Keys extends PropertyKey,
> = Omit<Payload<Method>, Keys>;
type TelegramEffect<Method extends keyof TelegramService> =
	ReturnType<TelegramService[Method]> extends Effect.Effect<
		infer A,
		infer E,
		unknown
	>
		? Effect.Effect<A, E, Telegram>
		: never;
type Reaction = NonNullable<Payload<'setMessageReaction'>['reaction']>;
type Action = Payload<'sendChatAction'>['action'];

export interface MessageContextService {
	readonly message: Message;
	readonly chatId: number;
	readonly messageId: number;
	readonly messageThreadId: number | undefined;
	readonly businessConnectionId: string | undefined;
	readonly reply: (
		text: string,
		options?: Options<
			'sendMessage',
			'chat_id' | 'text' | 'message_thread_id' | 'business_connection_id'
		>,
	) => TelegramEffect<'sendMessage'>;
	readonly replyToCurrent: (
		text: string,
		options?: Options<
			'sendMessage',
			| 'chat_id'
			| 'text'
			| 'message_thread_id'
			| 'business_connection_id'
			| 'reply_parameters'
		>,
	) => TelegramEffect<'sendMessage'>;
	readonly react: (
		reaction: Reaction,
		options?: Options<
			'setMessageReaction',
			'chat_id' | 'message_id' | 'reaction'
		>,
	) => TelegramEffect<'setMessageReaction'>;
	readonly editText: (
		text: string,
		options?: Options<
			'editMessageText',
			| 'chat_id'
			| 'message_id'
			| 'text'
			| 'business_connection_id'
			| 'inline_message_id'
		>,
	) => TelegramEffect<'editMessageText'>;
	readonly delete: () => TelegramEffect<'deleteMessage'>;
	readonly sendChatAction: (action: Action) => TelegramEffect<'sendChatAction'>;
}

export class MessageContext extends Context.Service<
	MessageContext,
	MessageContextService
>()('tfx/MessageContext') {}

export const make = (message: Message): MessageContextService => {
	const chatId = message.chat.id;
	const messageId = message.message_id;
	const messageThreadId = message.message_thread_id;
	const businessConnectionId = message.business_connection_id;
	const base = {
		chat_id: chatId,
		...(messageThreadId === undefined
			? {}
			: { message_thread_id: messageThreadId }),
		...(businessConnectionId === undefined
			? {}
			: { business_connection_id: businessConnectionId }),
	};
	const service: MessageContextService = {
		message,
		chatId,
		messageId,
		messageThreadId,
		businessConnectionId,
		reply: (text, options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.sendMessage({ ...options, ...base, text }),
			),
		replyToCurrent: (text, options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.sendMessage({
					...options,
					...base,
					text,
					reply_parameters: { message_id: messageId },
				}),
			),
		react: (reaction, options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.setMessageReaction({
					...options,
					chat_id: chatId,
					message_id: messageId,
					reaction,
				}),
			),
		editText: (text, options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.editMessageText({
					...options,
					chat_id: chatId,
					message_id: messageId,
					...(businessConnectionId === undefined
						? {}
						: { business_connection_id: businessConnectionId }),
					text,
				}),
			),
		delete: () =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.deleteMessage({ chat_id: chatId, message_id: messageId }),
			),
		sendChatAction: (action) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.sendChatAction({ ...base, action }),
			),
	};
	return Object.freeze(service);
};

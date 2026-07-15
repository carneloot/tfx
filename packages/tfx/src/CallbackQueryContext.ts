import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';

import type { Update } from './internal/telegram/generated/TelegramApi.types.js';
import { Telegram, type TelegramService } from './Telegram.js';

type Payload<Method extends keyof TelegramService> = NonNullable<
	Parameters<TelegramService[Method]>[0]
>;
type Options<
	Method extends keyof TelegramService,
	Keys extends PropertyKey,
> = Omit<Payload<Method>, Keys>;
type TelegramEffect<
	Method extends keyof TelegramService,
	AdditionalError = never,
> =
	ReturnType<TelegramService[Method]> extends Effect.Effect<
		infer A,
		infer E,
		unknown
	>
		? Effect.Effect<A, E | AdditionalError, Telegram>
		: never;
type CallbackQuery = NonNullable<Update['callback_query']>;
type CallbackMessage = NonNullable<CallbackQuery['message']>;

export class CallbackQueryContextError extends Error {
	readonly _tag = 'CallbackQueryContextError';
	constructor(readonly reason: 'InlineMessageCannotBeDeleted') {
		super('Cannot delete an inline callback query message');
	}
}

export interface CallbackQueryContextService {
	readonly callbackQuery: CallbackQuery;
	readonly callbackQueryId: string;
	readonly data: string | undefined;
	readonly message: CallbackMessage | undefined;
	readonly answer: (
		options?: Options<'answerCallbackQuery', 'callback_query_id'>,
	) => TelegramEffect<'answerCallbackQuery'>;
	readonly editMessageText: (
		text: string,
		options?: Options<
			'editMessageText',
			| 'chat_id'
			| 'message_id'
			| 'inline_message_id'
			| 'business_connection_id'
			| 'text'
		>,
	) => TelegramEffect<'editMessageText'>;
	readonly deleteMessage: () => TelegramEffect<
		'deleteMessage',
		CallbackQueryContextError
	>;
}

export class CallbackQueryContext extends Context.Service<
	CallbackQueryContext,
	CallbackQueryContextService
>()('tfx/CallbackQueryContext') {}

export const make = (
	callbackQuery: CallbackQuery,
): CallbackQueryContextService => {
	const message = callbackQuery.message;
	const concreteMessage = message as
		| undefined
		| {
				readonly chat: { readonly id: number };
				readonly message_id: number;
				readonly business_connection_id?: string;
		  };
	const messageTarget =
		concreteMessage === undefined
			? undefined
			: {
					chat_id: concreteMessage.chat.id,
					message_id: concreteMessage.message_id,
					...(concreteMessage.business_connection_id === undefined
						? {}
						: {
								business_connection_id: concreteMessage.business_connection_id,
							}),
				};
	const service: CallbackQueryContextService = {
		callbackQuery,
		callbackQueryId: callbackQuery.id,
		data: callbackQuery.data,
		message,
		answer: (options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.answerCallbackQuery({
					...options,
					callback_query_id: callbackQuery.id,
				}),
			),
		editMessageText: (text, options = {}) =>
			Effect.flatMap(Telegram, (telegram) =>
				telegram.editMessageText({
					...options,
					...(messageTarget ?? {
						inline_message_id: callbackQuery.inline_message_id as string,
					}),
					text,
				}),
			),
		deleteMessage: () =>
			messageTarget === undefined
				? Effect.fail(
						new CallbackQueryContextError('InlineMessageCannotBeDeleted'),
					)
				: Effect.flatMap(Telegram, (telegram) =>
						telegram.deleteMessage({
							chat_id: messageTarget.chat_id,
							message_id: messageTarget.message_id,
						}),
					),
	};
	return Object.freeze(service);
};

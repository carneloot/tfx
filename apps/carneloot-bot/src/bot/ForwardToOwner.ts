import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import {
	BotGroup,
	MessageContext,
	MessageHandler,
	MessageHandlerResult,
	MessageInput,
	Telegram,
} from 'tfx';
import { TelegramError } from 'tfx/TelegramError';

import { TelegramUserId } from '../domain/Ids.js';

export interface Options {
	readonly ownerChatId: number | undefined;
	readonly usernames: ReadonlyArray<string>;
}

export class Settings extends Context.Service<Settings, Options>()(
	'carneloot/ForwardToOwner/Settings',
) {}

export const group = BotGroup.make('forwarding').addMessage(
	MessageHandler.make('forwardToOwner', {
		input: MessageInput.message,
		error: TelegramError,
	}),
);

const SettingsSchema = Schema.Struct({
	usernames: Schema.Array(Schema.String),
	ownerChatId: Schema.UndefinedOr(TelegramUserId),
}).check(
	Schema.makeFilter(
		(value) => value.usernames.length === 0 || value.ownerChatId !== undefined,
		{
			message:
				'OWNER_TELEGRAM_ID is required when TELEGRAM_FORWARD_USERNAMES is configured',
		},
	),
);

export const config = Config.all({
	usernames: Config.String('TELEGRAM_FORWARD_USERNAMES').pipe(
		Config.withDefault(''),
		Config.map((value) =>
			value
				.split(',')
				.map((username) => username.trim().replace(/^@+/u, '').toLowerCase())
				.filter((username) => username.length > 0),
		),
	),
	ownerChatId: Config.option(Config.Int('OWNER_TELEGRAM_ID')).pipe(
		Config.map(Option.getOrUndefined),
	),
}).pipe(
	Config.mapEffect((value) =>
		Schema.decodeUnknownEffect(SettingsSchema)(value).pipe(
			Effect.mapError((error) => new Config.ConfigError(error)),
		),
	),
);

/** Runs after consuming replies, before generic responders such as hello. */
export const handle = Effect.fn('ForwardToOwner.handle')(function* () {
	const settings = yield* Settings;
	const context = yield* MessageContext.MessageContext;
	const message = context.message;
	const username = message.from?.username?.toLowerCase();
	const isCommand =
		message.entities?.some((entity) => entity.type === 'bot_command') ||
		message.caption_entities?.some((entity) => entity.type === 'bot_command') ||
		/^\/[\w]+(?:@\w+)?(?:\s|$)/u.test(message.text ?? message.caption ?? '');
	if (
		settings.ownerChatId === undefined ||
		username === undefined ||
		!settings.usernames.includes(username) ||
		isCommand
	)
		return MessageHandlerResult.unmatched;

	const telegram = yield* Telegram.Telegram;
	// Outputs are deliberately not retried: a network failure can hide a sent message.
	yield* telegram.forwardMessage({
		chat_id: settings.ownerChatId,
		from_chat_id: context.chatId,
		message_id: context.messageId,
	});
	yield* context.react([{ type: 'emoji', emoji: '🕊' }]);
	return MessageHandlerResult.unmatched;
});

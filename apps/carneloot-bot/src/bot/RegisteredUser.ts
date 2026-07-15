import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { MessageContext, Middleware } from 'tfx';

import {
	InvalidDomainInput,
	UserNotRegistered,
} from '../domain/DomainError.js';
import { BotId, TelegramUserId } from '../domain/Ids.js';
import { UserRepository } from '../ports/UserRepository.js';
import { CurrentUser } from './CurrentUser.js';
import { RegisteredUser, botId } from './Declaration.js';

export const live = Middleware.implement(
	RegisteredUser,
	Effect.gen(function* () {
		const context = yield* MessageContext.MessageContext;
		const repository = yield* UserRepository;
		const sender = context.message.from;
		if (sender === undefined) {
			yield* context.reply(
				'Por favor cadastre-se primeiro utilizando /cadastrar',
			);
			return yield* Effect.fail(
				new UserNotRegistered({ message: 'Missing sender' }),
			);
		}
		const parsedBotId = yield* Schema.decodeUnknownEffect(BotId)(botId).pipe(
			Effect.mapError(
				(cause) => new InvalidDomainInput({ message: 'Invalid bot id', cause }),
			),
		);
		const userId = yield* Schema.decodeUnknownEffect(TelegramUserId)(
			sender.id,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid Telegram user id',
						cause,
					}),
			),
		);
		return yield* repository
			.findByTelegram(parsedBotId, userId)
			.pipe(
				Effect.catchTag('UserNotRegistered', (error) =>
					Effect.andThen(
						context.reply(
							'Por favor cadastre-se primeiro utilizando /cadastrar',
						),
						Effect.fail(error),
					),
				),
			);
	}),
);
void CurrentUser;

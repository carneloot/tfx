import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { MessageContext } from 'tfx';

import * as RegisterUser from '../application/RegisterUser.js';
import { InvalidDomainInput } from '../domain/DomainError.js';
import { BotId, TelegramChatId, TelegramUserId } from '../domain/Ids.js';
import { botId } from './Declaration.js';

export const registerCurrent = Effect.gen(function* () {
	const context = yield* MessageContext.MessageContext;
	const sender = context.message.from;
	if (sender === undefined) {
		yield* context.reply('Não foi possível identificar o usuário.');
		return;
	}
	const decode = <A>(schema: Schema.Schema<A>, value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid Telegram identity',
						cause,
					}),
			),
		);
	const registered = yield* RegisterUser.execute({
		botId: yield* decode(BotId, botId),
		telegramUserId: yield* decode(TelegramUserId, sender.id),
		username: sender.username ?? null,
		firstName: sender.first_name,
		lastName: sender.last_name ?? null,
		privateChatId: yield* decode(TelegramChatId, sender.id),
	});
	yield* context.reply('Usuário cadastrado com sucesso!');
	return registered;
});

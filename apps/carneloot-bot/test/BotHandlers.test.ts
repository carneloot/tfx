import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { describe, expect, it } from 'vitest';

import { registerCurrent } from '../src/bot/AccountHandlers.js';
import * as RegisteredUserMiddleware from '../src/bot/RegisteredUser.js';
import { UserNotRegistered } from '../src/domain/DomainError.js';
import { UserId } from '../src/domain/Ids.js';
import type { RegisteredUser } from '../src/domain/User.js';
import { UserRepository } from '../src/ports/UserRepository.js';
const userId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const replies: Array<string> = [];
const context = (message: unknown) =>
	({
		message: message as never,
		chatId: 1,
		messageId: 1,
		messageThreadId: undefined,
		businessConnectionId: undefined,
		reply: (text: string) =>
			Effect.sync(() => {
				replies.push(text);
				return {} as never;
			}),
		replyToCurrent: () => Effect.succeed({} as never),
		react: () => Effect.succeed(true),
		editText: () => Effect.succeed({} as never),
		delete: () => Effect.succeed(true),
		sendChatAction: () => Effect.succeed(true),
	}) as unknown as MessageContextService;
const repository = Layer.succeed(UserRepository, {
	registerTelegramProfile: (profile) =>
		Effect.succeed({
			user: {
				id: userId,
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
			},
			profile,
		}),
	findByTelegram: () => Effect.die('unused'),
});
describe('account handler', () => {
	it('rejects updates without sender using exact text', async () => {
		replies.length = 0;
		const executable = Effect.provideService(
			Effect.provide(registerCurrent, repository),
			MessageContext,
			context({}),
		) as Effect.Effect<RegisteredUser | undefined, unknown>;
		await Effect.runPromise(executable);
		expect(replies).toEqual(['Não foi possível identificar o usuário.']);
	});
	it('registers sender and replies in invoking chat', async () => {
		replies.length = 0;
		const executable = Effect.provideService(
			Effect.provide(registerCurrent, repository),
			MessageContext,
			context({ from: { id: 42, first_name: 'Ana', username: 'ana' } }),
		) as Effect.Effect<RegisteredUser | undefined, unknown>;
		const result = await Effect.runPromise(executable);
		expect(result?.profile).toMatchObject({
			telegramUserId: 42,
			privateChatId: 42,
			username: 'ana',
		});
		expect(replies).toEqual(['Usuário cadastrado com sucesso!']);
	});
	it('replies with exact unregistered guidance and typed rejection', async () => {
		replies.length = 0;
		const missing = Layer.succeed(UserRepository, {
			registerTelegramProfile: () => Effect.die('unused'),
			findByTelegram: () =>
				Effect.fail(new UserNotRegistered({ message: 'missing' })),
		});
		const effect = Effect.provideService(
			Effect.provide(RegisteredUserMiddleware.live.effect, missing),
			MessageContext,
			context({ from: { id: 77, first_name: 'No' } }),
		) as Effect.Effect<unknown, unknown>;
		const result = await Effect.runPromise(Effect.result(effect));
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'UserNotRegistered' },
		});
		expect(replies).toEqual([
			'Por favor cadastre-se primeiro utilizando /cadastrar',
		]);
	});
});

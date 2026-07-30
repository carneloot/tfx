import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { describe, expect, it } from 'vitest';

import * as AddPetConversation from '../src/bot/AddPetConversation.js';
import { PetNameAlreadyExists } from '../src/domain/DomainError.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(2);
const identity = { ownerId, botId, telegramUserId };
const userLayer = Layer.succeed(UserRepository, {
	findById: () => Effect.die('unused'),
	findByUsername: () => Effect.succeed([]),
	registerTelegramProfile: () => Effect.die('unused'),
	findByTelegram: () =>
		Effect.succeed({
			user: {
				id: ownerId,
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
			},
			profile: {
				botId,
				telegramUserId,
				username: null,
				firstName: 'Ana',
				lastName: null,
				privateChatId: Schema.decodeUnknownSync(TelegramChatId)(2),
			},
		}),
});
const replies: Array<string> = [];
const replyOptions: Array<unknown> = [];
const message = {
	message: {} as never,
	chatId: 1,
	messageId: 1,
	messageThreadId: undefined,
	businessConnectionId: undefined,
	reply: (
		text: string,
		options: Parameters<MessageContextService['reply']>[1],
	) =>
		Effect.sync(() => {
			replies.push(text);
			replyOptions.push(options);
			return {} as never;
		}),
	replyToCurrent: () => Effect.succeed({} as never),
	react: () => Effect.succeed(true),
	editText: () => Effect.succeed({} as never),
	delete: () => Effect.succeed(true),
	sendChatAction: () => Effect.succeed(true),
} as unknown as MessageContextService;
describe('AddPetConversation', () => {
	it('persists primitive owner state and commits one pet before success output', async () => {
		replies.length = 0;
		replyOptions.length = 0;
		let inserts = 0;
		const petLayer = Layer.succeed(PetRepository, {
			findById: () => Effect.die('unused'),
			lockById: () => Effect.die('unused'),
			deleteOwned: () => Effect.die('unused'),
			addOwned: (_owner, name) =>
				Effect.sync(() => ({
					id: '00000000-0000-4000-8000-000000000002' as never,
					ownerId,
					name,
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
					...(inserts++, {}),
				})),
			listOwned: () => Effect.succeed([]),
			listAccessible: () => Effect.succeed([]),
		});
		const program = Effect.gen(function* () {
			const conversations = yield* Conversations;
			const scope = { botId: 'carneloot', chatId: 1, userId: 2 };
			yield* conversations.start(AddPetConversation.built, identity, { scope });
			const invalid = yield* conversations.resume(
				AddPetConversation.built,
				'Rex\u0000',
				{ scope, updateId: 9 },
			);
			const first = yield* conversations.resume(
				AddPetConversation.built,
				' Rex ',
				{ scope, updateId: 10 },
			);
			const duplicate = yield* conversations.resume(
				AddPetConversation.built,
				' Rex ',
				{ scope, updateId: 10 },
			);
			return { invalid, first, duplicate };
		});
		const dependencies = Layer.mergeAll(
			petLayer,
			userLayer,
			Layer.succeed(MessageContext, message),
		);
		const executable = Effect.provide(
			Effect.provide(program, ConversationsLive.layer),
			Layer.merge(MemoryConversationStorage.layer, dependencies),
		) as Effect.Effect<
			{
				readonly invalid: { readonly _tag: string };
				readonly first: { readonly _tag: string };
				readonly duplicate: { readonly _tag: string };
			},
			unknown
		>;
		const result = await Effect.runPromise(executable);
		expect(result.invalid._tag).toBe('Applied');
		expect(result.first._tag).toBe('Applied');
		expect(result.duplicate._tag).toBe('Missing');
		expect(inserts).toBe(1);
		expect(replies).toEqual([
			'Qual o nome do seu pet?',
			'Nome de pet inválido.',
			'Qual o nome do seu pet?',
			'Pet cadastrado com sucesso!',
		]);
		expect(replyOptions).toEqual([
			{ reply_markup: { remove_keyboard: true } },
			{ reply_markup: { remove_keyboard: true } },
			{ reply_markup: { remove_keyboard: true } },
			{ reply_markup: { remove_keyboard: true } },
		]);
	});
	it('re-prompts duplicate names and retains the conversation', async () => {
		replies.length = 0;
		replyOptions.length = 0;
		let inserts = 0;
		const petLayer = Layer.succeed(PetRepository, {
			findById: () => Effect.die('unused'),
			lockById: () => Effect.die('unused'),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => {
				inserts++;
				return Effect.fail(new PetNameAlreadyExists({ message: 'duplicate' }));
			},
			listOwned: () => Effect.succeed([]),
			listAccessible: () => Effect.succeed([]),
		});
		const scope = { botId: 'carneloot', chatId: 5, userId: 6 };
		const program = Effect.gen(function* () {
			const conversations = yield* Conversations;
			yield* conversations.start(AddPetConversation.built, identity, { scope });
			return yield* conversations.resume(AddPetConversation.built, 'Rex', {
				scope,
				updateId: 20,
			});
		});
		const executable = Effect.provide(
			Effect.provide(program, ConversationsLive.layer),
			Layer.merge(
				MemoryConversationStorage.layer,
				Layer.mergeAll(
					petLayer,
					userLayer,
					Layer.succeed(MessageContext, message),
				),
			),
		) as Effect.Effect<
			{ readonly _tag: string; readonly row?: unknown },
			unknown
		>;
		const result = await Effect.runPromise(executable);
		expect(result._tag).toBe('Applied');
		expect(result.row).toBeDefined();
		expect(inserts).toBe(1);
		expect(replies).toEqual([
			'Qual o nome do seu pet?',
			'Já existe um pet com esse nome.',
			'Qual o nome do seu pet?',
		]);
		expect(replyOptions).toEqual([
			{ reply_markup: { remove_keyboard: true } },
			{ reply_markup: { remove_keyboard: true } },
			{ reply_markup: { remove_keyboard: true } },
		]);
	});
	it('rejects corrupt persisted identity state before mutation', async () => {
		let inserts = 0;
		const petLayer = Layer.succeed(PetRepository, {
			findById: () => Effect.die('unused'),
			lockById: () => Effect.die('unused'),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => {
				inserts++;
				return Effect.die('must not run');
			},
			listOwned: () => Effect.succeed([]),
			listAccessible: () => Effect.succeed([]),
		});
		const scope = { botId: 'carneloot', chatId: 7, userId: 8 };
		const program = Effect.gen(function* () {
			const storage = yield* ConversationStorage;
			yield* storage.create(
				{
					scope,
					originTrace: undefined,
					conversationId: AddPetConversation.declaration.id,
					version: 1,
					step: 'name',
					state: { ownerId },
					lastUpdateId: undefined,
					expiresAt: undefined,
				},
				'fail',
			);
			return yield* Effect.result(
				(yield* Conversations).resume(AddPetConversation.built, 'Rex', {
					scope,
					updateId: 30,
				}),
			);
		});
		const executable = Effect.provide(
			Effect.provide(program, ConversationsLive.layer),
			Layer.mergeAll(
				MemoryConversationStorage.layer,
				petLayer,
				userLayer,
				Layer.succeed(MessageContext, message),
			),
		) as unknown as Effect.Effect<{ readonly _tag: string }, never>;
		const result = await Effect.runPromise(executable);
		expect(result._tag).toBe('Failure');
		expect(inserts).toBe(0);
	});
});

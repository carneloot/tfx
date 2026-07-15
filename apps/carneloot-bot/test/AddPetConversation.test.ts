import { Effect, Layer, Schema } from 'effect';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { describe, expect, it } from 'vitest';

import * as AddPetConversation from '../src/bot/AddPetConversation.js';
import { PetNameAlreadyExists } from '../src/domain/DomainError.js';
import { UserId } from '../src/domain/Ids.js';
import { PetRepository } from '../src/ports/PetRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const replies: Array<string> = [];
const message = {
	message: {} as never,
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
} as unknown as MessageContextService;
describe('AddPetConversation', () => {
	it('persists primitive owner state and commits one pet before success output', async () => {
		let inserts = 0;
		const petLayer = Layer.succeed(PetRepository, {
			addOwned: (_owner, name) =>
				Effect.sync(() => ({
					id: '00000000-0000-4000-8000-000000000002' as never,
					ownerId,
					name,
					createdAt: 0,
					updatedAt: 0,
					...(inserts++, {}),
				})),
			listOwned: () => Effect.succeed([]),
		});
		const program = Effect.gen(function* () {
			const conversations = yield* Conversations;
			const scope = { botId: 'carneloot', chatId: 1, userId: 2 };
			yield* conversations.start(AddPetConversation.built, ownerId, { scope });
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
		const dependencies = Layer.merge(
			petLayer,
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
	});
	it('re-prompts duplicate names and retains the conversation', async () => {
		replies.length = 0;
		let inserts = 0;
		const petLayer = Layer.succeed(PetRepository, {
			addOwned: () => {
				inserts++;
				return Effect.fail(new PetNameAlreadyExists({ message: 'duplicate' }));
			},
			listOwned: () => Effect.succeed([]),
		});
		const scope = { botId: 'carneloot', chatId: 5, userId: 6 };
		const program = Effect.gen(function* () {
			const conversations = yield* Conversations;
			yield* conversations.start(AddPetConversation.built, ownerId, { scope });
			return yield* conversations.resume(AddPetConversation.built, 'Rex', {
				scope,
				updateId: 20,
			});
		});
		const executable = Effect.provide(
			Effect.provide(program, ConversationsLive.layer),
			Layer.merge(
				MemoryConversationStorage.layer,
				Layer.merge(petLayer, Layer.succeed(MessageContext, message)),
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
	});
});

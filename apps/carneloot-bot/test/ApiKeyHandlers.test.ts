import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as ConversationsLive from 'tfx/Conversations';
import { Conversations } from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import * as MessageContext from 'tfx/MessageContext';
import * as UpdateContext from 'tfx/UpdateContext';
import { describe, expect, it } from 'vitest';

import * as FakeTelegram from '../../../packages/tfx/test/internal/FakeTelegram.js';
import { RecordedRequests } from '../../../packages/tfx/test/internal/RecordedRequests.js';
import * as GenerateApiKey from '../src/application/GenerateApiKey.js';
import * as ApiKeyHandlers from '../src/bot/ApiKeyHandlers.js';
import * as Confirmation from '../src/bot/conversations/GenerateApiKeyConversation.js';
import { CurrentUser } from '../src/bot/CurrentUser.js';
import { UserNotRegistered } from '../src/domain/DomainError.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { ApiKeyRepository } from '../src/ports/ApiKeyRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';

const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const actorId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const now = DateTime.makeUnsafe(0);
const current = {
	user: { id: actorId, createdAt: now, updatedAt: now },
	profile: {
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
		firstName: 'Ana',
		lastName: null,
		username: null,
	},
};
const scope = { botId, chatId: 42, userId: 42 };
const message = {
	message_id: 1,
	date: 100,
	chat: { id: 42, type: 'private' as const },
	from: { id: 42, first_name: 'Ana', is_bot: false },
};
const harness = (initialHash: string | undefined, sends: number) => {
	let storedHash = initialHash;
	let writes = 0;
	let registered = true;
	const layer = Layer.mergeAll(
		Layer.provideMerge(
			ConversationsLive.layer,
			MemoryConversationStorage.layer,
		),
		NodeCrypto.layer,
		FakeTelegram.layer(
			Array.from({ length: sends }, (_, i) =>
				FakeTelegram.succeed('sendMessage', { message_id: i + 1 }),
			),
		),
		Layer.succeed(CurrentUser, current),
		Layer.succeed(MessageContext.MessageContext, MessageContext.make(message)),
		Layer.succeed(
			UpdateContext.UpdateContext,
			UpdateContext.make({ update_id: 1, message }),
		),
		Layer.succeed(UserRepository, {
			findById: () => Effect.succeed(current),
			findByUsername: () => Effect.succeed([]),
			registerTelegramProfile: () => Effect.succeed(current),
			findByTelegram: () =>
				registered
					? Effect.succeed(current)
					: Effect.fail(new UserNotRegistered({ message: 'not registered' })),
		}),
		Layer.succeed(ApiKeyRepository, {
			findOwner: (hash) =>
				Effect.sync(() => (hash === storedHash ? actorId : undefined)),
			replace: (input) =>
				Effect.sync(() => {
					if (storedHash !== undefined && !input.confirmed) return false;
					storedHash = input.hash;
					writes++;
					return true;
				}),
		}),
	);
	return {
		layer,
		hash: () => storedHash,
		writes: () => writes,
		unregister: () => {
			registered = false;
		},
	};
};

describe('API key command and confirmation', () => {
	it.each([undefined, 'previous-hash'])(
		'rejects group issuance or rotation without changing an existing key: %s',
		async (initialHash) => {
			const h = harness(initialHash, 2);
			const groupContext = MessageContext.make({
				...message,
				chat: { id: -100, type: 'supergroup', title: 'Group' },
			});
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* ApiKeyHandlers.startGenerateApiKey.pipe(
						Effect.provideService(MessageContext.MessageContext, groupContext),
					);
					// Even a previously persisted confirmation cannot bypass the issuance boundary.
					yield* Confirmation.issue(true).pipe(
						Effect.provideService(MessageContext.MessageContext, groupContext),
					);
					const storage = yield* ConversationStorage;
					expect(yield* storage.load(scope)).toBeUndefined();
					const recorded = yield* RecordedRequests;
					expect(
						(yield* recorded.method('sendMessage')).map(({ input }) => input),
					).toEqual(
						Array.from({ length: 2 }, () => ({
							chat_id: -100,
							text: 'Para gerar uma chave, fale comigo no privado.',
							reply_markup: { remove_keyboard: true },
						})),
					);
				}).pipe(Effect.provide(h.layer)),
			);
			expect(h.hash()).toBe(initialHash);
			expect(h.writes()).toBe(0);
		},
	);

	it('shows a first key once, stores only its hash, and does not create a conversation', async () => {
		const h = harness(undefined, 1);
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* ApiKeyHandlers.startGenerateApiKey;
				const recorded = yield* RecordedRequests;
				const requests = yield* recorded.method('sendMessage');
				expect(requests).toHaveLength(1);
				const output = Schema.decodeUnknownSync(
					Schema.Struct({ text: Schema.String, parse_mode: Schema.String }),
				)(requests[0]?.input);
				expect(output.parse_mode).toBe('HTML');
				const key = /^Aqui está: <pre>([0-9a-f]{64})<\/pre>$/u.exec(
					output.text,
				)?.[1];
				if (key === undefined)
					return yield* Effect.die('expected key response');
				expect(h.hash()).toBe(yield* GenerateApiKey.hash(key));
				expect(h.hash()).not.toBe(key);
				const storage = yield* ConversationStorage;
				expect(yield* storage.load(scope)).toBeUndefined();
			}).pipe(Effect.provide(h.layer)),
		);
		expect(h.writes()).toBe(1);
	});
	it.each(['No', 'Yes'])(
		'keeps the previous key until explicit confirmation: %s',
		async (answer) => {
			const h = harness('previous-hash', 2);
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* ApiKeyHandlers.startGenerateApiKey;
					expect(h.hash()).toBe('previous-hash');
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.state).toEqual({ actorId });
					const conversations = yield* Conversations;
					yield* conversations.resume(Confirmation.built, answer, {
						scope,
						updateId: 2,
					});
					yield* conversations.resume(Confirmation.built, answer, {
						scope,
						updateId: 2,
					});
					expect(yield* storage.load(scope)).toBeUndefined();
					const recorded = yield* RecordedRequests;
					const requests = yield* recorded.method('sendMessage');
					expect(requests).toHaveLength(2);
					const output = Schema.decodeUnknownSync(
						Schema.Struct({ text: Schema.String }),
					)(requests[1]?.input);
					if (answer === 'No') expect(output.text).toBe('Okay!');
					else
						expect(output.text).toMatch(
							/^Aqui está: <pre>[0-9a-f]{64}<\/pre>$/u,
						);
				}).pipe(Effect.provide(h.layer)),
			);
			expect(h.writes()).toBe(answer === 'Yes' ? 1 : 0);
		},
	);
	it('reauthorizes registration before issuing a key', async () => {
		const h = harness(undefined, 0);
		h.unregister();
		const result = await Effect.runPromise(
			Effect.result(
				GenerateApiKey.execute({
					botId,
					actorId,
					telegramUserId: current.profile.telegramUserId,
					confirmed: false,
				}),
			).pipe(Effect.provide(h.layer)),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'UserNotRegistered' },
		});
		expect(h.writes()).toBe(0);
	});
});

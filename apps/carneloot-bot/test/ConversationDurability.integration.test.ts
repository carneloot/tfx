import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxMigrations from '@tfx/postgres/Migrations';
import * as PostgresConversationStorage from '@tfx/postgres/PostgresConversationStorage';
import * as PostgresUpdateDeduplicator from '@tfx/postgres/PostgresUpdateDeduplicator';
import { DateTime, Duration, Effect, Layer, Schema } from 'effect';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import * as AddPetConversation from '../src/bot/AddPetConversation.js';
import * as ConfigureReminderDelayConversation from '../src/bot/conversations/ConfigureReminderDelayConversation.js';
import { BotId, TelegramChatId, TelegramUserId } from '../src/domain/Ids.js';
import { PetName } from '../src/domain/Pet.js';
import { PetFoodRepository } from '../src/ports/PetFoodRepository.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { ReminderScheduler } from '../src/ports/ReminderScheduler.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import * as RepositoriesLive from '../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const tfxOptions = {
	schema: 'tfx_plan09',
	tablePrefix: 'case_',
};
const storage = PostgresConversationStorage.layer(tfxOptions);
const dedup = PostgresUpdateDeduplicator.layer({
	...tfxOptions,
	botId: 'carneloot',
});
const tfxPersistence = Layer.unwrap(
	Effect.as(TfxMigrations.migrate(tfxOptions), Layer.merge(storage, dedup)),
);
const services = <E, R>(pg: Layer.Layer<PgClient.PgClient, E, R>) =>
	Layer.provideMerge(Layer.merge(tfxPersistence, RepositoriesLive.layer), pg);
const message = {
	reply: () => Effect.succeed({} as never),
} as unknown as MessageContextService;
const scheduler = Layer.succeed(ReminderScheduler, {
	replaceForLatest: () => Effect.void,
	cancelForPet: () => Effect.void,
});
const profile = {
	botId: Schema.decodeUnknownSync(BotId)('carneloot'),
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(9020),
	username: null,
	firstName: 'Restart',
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(9020),
};
describe.skipIf(!enabled)('Plan09 conversation durability', () => {
	it('rebuilds runtime layers and resumes a persisted add-pet conversation', async () => {
		const scope = { botId: 'carneloot', chatId: 9020, userId: 9020 };
		const start = Effect.gen(function* () {
			const owner = yield* (yield* UserRepository).registerTelegramProfile(
				profile,
			);
			yield* (yield* Conversations).start(
				AddPetConversation.built,
				{
					ownerId: owner.user.id,
					botId: owner.profile.botId,
					telegramUserId: owner.profile.telegramUserId,
				},
				{ scope },
			);
			return owner.user.id;
		});
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient;
					const pg = Layer.succeed(PgClient.PgClient, sql);
					const firstRuntime = Layer.merge(
						services(pg),
						Layer.succeed(MessageContext, message),
					);
					const ownerId = yield* Effect.provide(
						Effect.provide(start, ConversationsLive.layer),
						firstRuntime,
					);
					const resume = Effect.gen(function* () {
						const result = yield* (yield* Conversations).resume(
							AddPetConversation.built,
							'Rex',
							{ scope, updateId: 700 },
						);
						const pets = yield* (yield* PetRepository).listOwned(
							ownerId as never,
						);
						return { result, pets };
					});
					const secondRuntime = Layer.merge(
						services(pg),
						Layer.succeed(MessageContext, message),
					);
					return yield* Effect.provide(
						Effect.provide(resume, ConversationsLive.layer),
						secondRuntime,
					);
				}),
				PostgresTestLayer.layer,
			) as unknown as Effect.Effect<
				{ result: { _tag: string }; pets: ReadonlyArray<{ name: string }> },
				unknown
			>,
		);
		expect(result.result._tag).toBe('Applied');
		expect(result.pets.map((pet) => pet.name)).toEqual(['Rex']);
	});
	it('resumes reminder-delay action state containing an existing delay', async () => {
		const telegramId = Date.now();
		const scope = {
			botId: 'carneloot',
			chatId: telegramId,
			userId: telegramId,
		};
		const replies: Array<string> = [];
		const capturedMessage = {
			reply: (text: string) =>
				Effect.sync(() => {
					replies.push(text);
					return {} as never;
				}),
		} as unknown as MessageContextService;
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient;
					const pg = Layer.succeed(PgClient.PgClient, sql);
					const runtime = Layer.mergeAll(
						services(pg),
						scheduler,
						Layer.succeed(MessageContext, capturedMessage),
						Layer.succeed(Telegram, {} as never),
					);
					yield* Effect.provide(
						Effect.provide(
							Effect.gen(function* () {
								const owner =
									yield* (yield* UserRepository).registerTelegramProfile({
										...profile,
										telegramUserId:
											Schema.decodeUnknownSync(TelegramUserId)(telegramId),
										privateChatId:
											Schema.decodeUnknownSync(TelegramChatId)(telegramId),
									});
								const pet = yield* (yield* PetRepository).addOwned(
									owner.user.id,
									Schema.decodeUnknownSync(PetName)('Barto'),
								);
								yield* (yield* PetFoodRepository).setReminderDelay(
									pet.id,
									Duration.hours(2),
									yield* DateTime.now,
								);
								const conversations = yield* Conversations;
								yield* conversations.start(
									ConfigureReminderDelayConversation.built,
									{
										ownerId: owner.user.id,
										botId: owner.profile.botId,
										telegramUserId: owner.profile.telegramUserId,
										pets: [{ id: pet.id, name: pet.name }],
									},
									{ scope },
								);
								yield* conversations.resume(
									ConfigureReminderDelayConversation.built,
									'Barto',
									{ scope, updateId: telegramId },
								);
							}),
							ConversationsLive.layer,
						),
						runtime,
					);
					return yield* Effect.provide(
						Effect.provide(
							Effect.gen(function* () {
								const resumed = yield* (yield* Conversations).resume(
									ConfigureReminderDelayConversation.built,
									'Alterar',
									{ scope, updateId: telegramId + 1 },
								);
								const row = yield* (yield* ConversationStorage).load(scope);
								return { resumed, row };
							}),
							ConversationsLive.layer,
						),
						runtime,
					);
				}),
				PostgresTestLayer.layer,
			),
		);
		expect(replies).toContain(
			'Atraso atual: 2 horas. Envie Alterar ou Excluir.',
		);
		expect(replies.at(-1)).toBe(
			'Envie a duração, por exemplo 30 minutos ou 2 horas.',
		);
		expect(result.resumed._tag).toBe('Applied');
		expect(result.row?.step).toBe('duration');
	});

	it('fences storage replay and durable dedup claims', async () => {
		const scope = { botId: 'carneloot', chatId: 9030, userId: 9030 };
		const updateId = 7030;
		const program = Effect.gen(function* () {
			const owner = yield* (yield* UserRepository).registerTelegramProfile({
				...profile,
				telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(9030),
				privateChatId: Schema.decodeUnknownSync(TelegramChatId)(9030),
			});
			const store = yield* ConversationStorage;
			yield* store.create(
				{
					scope,
					conversationId: 'direct',
					version: 1,
					step: 'name',
					state: {},
					lastUpdateId: undefined,
					expiresAt: undefined,
				},
				'replace',
			);
			const pets = yield* PetRepository;
			let executions = 0;
			const apply = () =>
				store.transition(scope, updateId, 0, (row) =>
					Effect.map(
						pets.addOwned(
							owner.user.id,
							Schema.decodeUnknownSync(PetName)('CAS'),
						),
						() => ({
							value: ++executions,
							mutation: {
								_tag: 'Persist' as const,
								step: row.step,
								state: row.state,
							},
						}),
					),
				);
			const first = yield* apply();
			const replay = yield* apply();
			const updateDedup = yield* UpdateDeduplicator;
			const claim = yield* updateDedup.claim(updateId);
			if (claim._tag !== 'Acquired') throw new Error('expected acquired');
			yield* updateDedup.complete(claim.token, DispatchOutcome.handled);
			const duplicateClaim = yield* updateDedup.claim(updateId);
			return {
				first,
				replay,
				executions,
				duplicateClaim,
				listed: yield* pets.listOwned(owner.user.id),
			};
		});
		const result = await Effect.runPromise(
			Effect.provide(program, services(PostgresTestLayer.layer)),
		);
		expect(result.first._tag).toBe('Applied');
		expect(result.replay._tag).toBe('Duplicate');
		expect(result.executions).toBe(1);
		expect(result.listed.map((pet) => pet.name)).toContain('CAS');
		expect(result.duplicateClaim._tag).toBe('Completed');
	});
});

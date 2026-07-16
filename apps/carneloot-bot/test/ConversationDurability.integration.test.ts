import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxMigrations from '@tfx/postgres/Migrations';
import * as PostgresConversationStorage from '@tfx/postgres/PostgresConversationStorage';
import * as PostgresUpdateDeduplicator from '@tfx/postgres/PostgresUpdateDeduplicator';
import { Effect, Layer, Schema } from 'effect';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import * as AddPetConversation from '../src/bot/AddPetConversation.js';
import { BotId, TelegramChatId, TelegramUserId } from '../src/domain/Ids.js';
import { PetName } from '../src/domain/Pet.js';
import { PetRepository } from '../src/ports/PetRepository.js';
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

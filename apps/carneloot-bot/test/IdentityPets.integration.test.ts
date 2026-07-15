import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../src/domain/Ids.js';
import { PetName } from '../src/domain/Pet.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import { migrate } from '../src/postgres/AppMigrator.js';
import { migration0001Checksum } from '../src/postgres/Migration0001Sql.js';
import * as PetRepositoryLive from '../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../src/postgres/UserRepositoryLive.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapters = Layer.merge(
	UserRepositoryLive.layer,
	PetRepositoryLive.layer,
).pipe(Layer.provideMerge(PostgresTestLayer.layer));
const profile = {
	botId: Schema.decodeUnknownSync(BotId)('carneloot'),
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(9001),
	username: 'old' as string | null,
	firstName: 'Ana',
	lastName: 'Silva' as string | null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(9001),
};
describe.skipIf(!enabled)('identity and pets PostgreSQL', () => {
	it('migrates concurrently and registers one durable user', async () => {
		const program = Effect.gen(function* () {
			yield* Effect.all([migrate, migrate], { concurrency: 'unbounded' });
			const users = yield* UserRepository;
			const [a, b] = yield* Effect.all(
				[
					users.registerTelegramProfile(profile),
					users.registerTelegramProfile({
						...profile,
						username: null,
						firstName: 'Ana Maria',
						lastName: null,
					}),
				],
				{ concurrency: 'unbounded' },
			);
			const sql = yield* PgClient.PgClient;
			const counts = yield* sql<{
				users: number;
				identities: number;
			}>`SELECT (SELECT count(*)::int FROM carneloot.telegram_identities WHERE bot_id=${profile.botId} AND telegram_user_id=${profile.telegramUserId}) users,(SELECT count(*)::int FROM carneloot.telegram_identities WHERE bot_id=${profile.botId} AND telegram_user_id=${profile.telegramUserId}) identities`;
			return { a, b, counts: counts[0] };
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.a.user.id).toBe(result.b.user.id);
		expect(result.counts).toMatchObject({ users: 1, identities: 1 });
	});
	it('rejects migration checksum drift without applying work', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const sql = yield* PgClient.PgClient;
			yield* sql`UPDATE carneloot.app_migrations SET checksum='drift' WHERE version=1`;
			const result = yield* Effect.result(migrate);
			yield* sql`UPDATE carneloot.app_migrations SET checksum=${migration0001Checksum} WHERE version=1`;
			return result;
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'DomainPersistenceError' },
		});
	});
	it('preserves ownership, maps only named duplicate, and sorts', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const pets = yield* PetRepository;
			const owner = yield* users.registerTelegramProfile(profile);
			yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Zeca'),
			);
			yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Bidu'),
			);
			const duplicate = yield* Effect.result(
				pets.addOwned(
					owner.user.id,
					Schema.decodeUnknownSync(PetName)(' bidu '),
				),
			);
			return { listed: yield* pets.listOwned(owner.user.id), duplicate };
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.listed.map((pet) => pet.name)).toEqual(['Bidu', 'Zeca']);
		expect(result.duplicate).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'PetNameAlreadyExists' },
		});
	});
});

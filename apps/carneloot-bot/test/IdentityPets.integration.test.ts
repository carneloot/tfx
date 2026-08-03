import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Redacted, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../src/domain/Ids.js';
import { PetName } from '../src/domain/Pet.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import { migrate } from '../src/postgres/AppMigrator.js';
import { migration0001Checksum } from '../src/postgres/Migration0001Sql.js';
import * as PetRepositoryLive from '../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../src/postgres/UserRepositoryLive.js';
import * as DeterministicCrypto from './internal/DeterministicCrypto.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapters = Layer.merge(
	UserRepositoryLive.layer,
	PetRepositoryLive.layer,
).pipe(
	Layer.provideMerge(
		Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
	),
);
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
			}>`SELECT (SELECT count(*)::int FROM carneloot.users WHERE id=${a.user.id}::uuid) users,(SELECT count(*)::int FROM carneloot.telegram_identities WHERE bot_id=${profile.botId} AND telegram_user_id=${profile.telegramUserId}) identities`;
			const ledger = yield* sql<{
				count: number;
				checksum: string;
			}>`SELECT count(*)::int count,max(checksum) checksum FROM carneloot.app_migrations WHERE version=1 GROUP BY version`;
			return { a, b, counts: counts[0], ledger: ledger[0] };
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.a.user.id).toBe(result.b.user.id);
		expect(result.counts).toMatchObject({ users: 1, identities: 1 });
		expect(result.ledger).toEqual({
			count: 1,
			checksum: migration0001Checksum,
		});
	});
	it('refreshes nullable profile fields and allows shared usernames', async () => {
		const secondProfile = {
			...profile,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(9002),
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(9002),
		};
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const pets = yield* PetRepository;
			yield* TestClock.setTime(1_000);
			const first = yield* users.registerTelegramProfile(profile);
			const createdPet = yield* pets.addOwned(
				first.user.id,
				Schema.decodeUnknownSync(PetName)('Persistente'),
			);
			yield* TestClock.setTime(2_000);
			const refreshed = yield* users.registerTelegramProfile({
				...profile,
				username: null,
				firstName: 'Ana Maria',
				lastName: null,
			});
			yield* users.registerTelegramProfile({ ...profile, username: 'shared' });
			const shared = yield* users.registerTelegramProfile({
				...secondProfile,
				username: 'shared',
			});
			return {
				first,
				refreshed,
				shared,
				createdPet,
				pets: yield* pets.listOwned(first.user.id),
			};
		});
		const result = await Effect.runPromise(
			Effect.provide(program, Layer.merge(adapters, TestClock.layer())),
		);
		expect(result.refreshed.user.id).toBe(result.first.user.id);
		expect(DateTime.toEpochMillis(result.first.user.createdAt)).toBe(1_000);
		expect(DateTime.toEpochMillis(result.first.user.updatedAt)).toBe(1_000);
		expect(DateTime.toEpochMillis(result.createdPet.createdAt)).toBe(1_000);
		expect(DateTime.toEpochMillis(result.createdPet.updatedAt)).toBe(1_000);
		expect(DateTime.toEpochMillis(result.refreshed.user.updatedAt)).toBe(2_000);
		expect(result.refreshed.profile).toMatchObject({
			username: null,
			firstName: 'Ana Maria',
			lastName: null,
		});
		expect(result.shared.user.id).not.toBe(result.first.user.id);
		expect(result.pets.map((pet) => pet.name)).toContain('Persistente');
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
	it.skipIf(process.env.TEST_DATABASE_URL === undefined)(
		'refuses to certify an incompatible preexisting table without a ledger',
		async () => {
			const database = `carneloot_drift_${crypto.randomUUID().replaceAll('-', '')}`;
			const admin = Effect.flatMap(
				PgClient.PgClient,
				(sql) => sql`CREATE DATABASE ${sql(database)}`,
			);
			await Effect.runPromise(Effect.provide(admin, PostgresTestLayer.layer));
			try {
				const url = new URL(process.env.TEST_DATABASE_URL!);
				url.pathname = `/${database}`;
				const isolated = PgClient.layer({ url: Redacted.make(url.toString()) });
				const program = Effect.gen(function* () {
					const sql = yield* PgClient.PgClient;
					yield* sql`CREATE SCHEMA carneloot`;
					yield* sql`CREATE TABLE carneloot.users (wrong text)`;
					const result = yield* Effect.result(migrate);
					const ledger = yield* sql<{
						ledger: string | null;
					}>`SELECT to_regclass('carneloot.app_migrations')::text ledger`;
					return { result, ledger: ledger[0]?.ledger };
				});
				const result = await Effect.runPromise(
					Effect.scoped(Effect.provide(program, isolated)),
				);
				expect(result.result._tag).toBe('Failure');
				expect(result.ledger).toBeNull();
			} finally {
				const cleanup = Effect.flatMap(PgClient.PgClient, (sql) =>
					Effect.andThen(
						sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${database}`,
						sql`DROP DATABASE IF EXISTS ${sql(database)}`,
					),
				);
				await Effect.runPromise(
					Effect.provide(cleanup, PostgresTestLayer.layer),
				);
			}
		},
	);
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
	it('enforces byte limits and explicit FK deletion policies in SQL', async () => {
		const directProfile = {
			...profile,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(9010),
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(9010),
		};
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const owner = yield* users.registerTelegramProfile(directProfile);
			const sql = yield* PgClient.PgClient;
			const now = new Date();
			const accepted = '🐶'.repeat(20);
			yield* sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${owner.user.id}::uuid,${accepted},${accepted},${now},${now})`;
			const tooLong = '🐱'.repeat(21);
			const rejected = yield* Effect.result(
				sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${owner.user.id}::uuid,${tooLong},${tooLong},${now},${now})`,
			);
			const restricted = yield* Effect.result(
				sql`DELETE FROM carneloot.users WHERE id=${owner.user.id}::uuid`,
			);
			yield* sql`DELETE FROM carneloot.pets WHERE owner_id=${owner.user.id}::uuid`;
			yield* sql`DELETE FROM carneloot.users WHERE id=${owner.user.id}::uuid`;
			const identities = yield* sql<{
				count: number;
			}>`SELECT count(*)::int count FROM carneloot.telegram_identities WHERE user_id=${owner.user.id}::uuid`;
			return { rejected, restricted, identities: identities[0]?.count };
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.rejected._tag).toBe('Failure');
		expect(result.restricted._tag).toBe('Failure');
		expect(result.identities).toBe(0);
	});
});

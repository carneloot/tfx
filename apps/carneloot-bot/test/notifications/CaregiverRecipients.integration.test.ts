import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { BotId, PetId, TelegramChatId, UserId } from '../../src/domain/Ids.js';
import { NotificationRecipients } from '../../src/ports/NotificationRecipients.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
);
const botId = Schema.decodeUnknownSync(BotId)('caregiver-recipients');
const otherBotId = Schema.decodeUnknownSync(BotId)(
	'caregiver-recipients-other',
);
const userId = () => Schema.decodeUnknownSync(UserId)(crypto.randomUUID());
const petId = () => Schema.decodeUnknownSync(PetId)(crypto.randomUUID());

const insertUser = (sql: PgClient.PgClient, id: UserId) =>
	sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${id}::uuid,now(),now())`;
const insertPet = (sql: PgClient.PgClient, id: PetId, ownerId: UserId) =>
	sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${id}::uuid,${ownerId}::uuid,${id},${id},now(),now())`;
const insertIdentity = (
	sql: PgClient.PgClient,
	identityBotId: BotId,
	id: UserId,
	telegramId: number,
) =>
	sql`INSERT INTO carneloot.telegram_identities (bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES (${identityBotId},${telegramId},${id}::uuid,NULL,'Recipient',NULL,${telegramId},now(),now())`;
const insertCaregiver = (
	sql: PgClient.PgClient,
	pet: PetId,
	caregiverId: UserId,
	status: 'pending' | 'accepted' | 'rejected',
) =>
	sql`INSERT INTO carneloot.pet_caregivers (pet_id,caregiver_user_id,status,created_at,updated_at) VALUES (${pet}::uuid,${caregiverId}::uuid,${status},now(),now())`;

if (!enabled)
	describe.skip('caregiver notification recipients PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('caregiver notification recipients PostgreSQL', () => {
		it('returns owner followed by accepted caregivers in stable user-id order', async () => {
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const recipients = yield* NotificationRecipients;
				const ownerId = userId();
				const acceptedHigh = Schema.decodeUnknownSync(UserId)(
					'ffffffff-ffff-4fff-8fff-ffffffffffff',
				);
				const acceptedLow = Schema.decodeUnknownSync(UserId)(
					'00000000-0000-4000-8000-000000000001',
				);
				const pending = userId();
				const rejected = userId();
				const pet = petId();
				for (const id of [
					ownerId,
					acceptedHigh,
					acceptedLow,
					pending,
					rejected,
				])
					yield* insertUser(sql, id);
				yield* insertPet(sql, pet, ownerId);
				yield* insertIdentity(sql, botId, ownerId, 101);
				yield* insertIdentity(sql, botId, acceptedHigh, 102);
				yield* insertIdentity(sql, botId, acceptedLow, 103);
				yield* insertIdentity(sql, botId, pending, 104);
				yield* insertIdentity(sql, botId, rejected, 105);
				yield* insertCaregiver(sql, pet, acceptedHigh, 'accepted');
				yield* insertCaregiver(sql, pet, acceptedLow, 'accepted');
				yield* insertCaregiver(sql, pet, pending, 'pending');
				yield* insertCaregiver(sql, pet, rejected, 'rejected');
				return {
					ownerId,
					resolved: yield* recipients.resolvePetRecipients(botId, pet),
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.resolved.map(({ userId: id, role }) => [id, role])).toEqual(
				[
					[result.ownerId, 'owner'],
					['00000000-0000-4000-8000-000000000001', 'caregiver'],
					['ffffffff-ffff-4fff-8fff-ffffffffffff', 'caregiver'],
				],
			);
			expect(result.resolved).toHaveLength(3);
			expect(
				result.resolved.every(
					({ resolution }) => resolution._tag === 'Reachable',
				),
			).toBe(true);
		});

		it('returns owner only and excludes owner or caregiver actors', async () => {
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const recipients = yield* NotificationRecipients;
				const ownerId = userId();
				const caregiverId = userId();
				const ownerOnlyPet = petId();
				const sharedPet = petId();
				yield* insertUser(sql, ownerId);
				yield* insertUser(sql, caregiverId);
				yield* insertPet(sql, ownerOnlyPet, ownerId);
				yield* insertPet(sql, sharedPet, ownerId);
				yield* insertIdentity(sql, botId, ownerId, 201);
				yield* insertIdentity(sql, botId, caregiverId, 202);
				yield* insertCaregiver(sql, sharedPet, caregiverId, 'accepted');
				return {
					ownerOnly: yield* recipients.resolvePetRecipients(
						botId,
						ownerOnlyPet,
					),
					ownerExcluded: yield* recipients.resolvePetRecipients(
						botId,
						sharedPet,
						{
							excludeUserId: ownerId,
						},
					),
					caregiverExcluded: yield* recipients.resolvePetRecipients(
						botId,
						sharedPet,
						{ excludeUserId: caregiverId },
					),
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.ownerOnly).toHaveLength(1);
			expect(result.ownerOnly[0]).toMatchObject({ role: 'owner' });
			expect(result.ownerExcluded).toEqual([
				expect.objectContaining({ role: 'caregiver' }),
			]);
			expect(result.caregiverExcluded).toEqual([
				expect.objectContaining({ role: 'owner' }),
			]);
		});

		it('audits missing bot-scoped private chats as unreachable', async () => {
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const recipients = yield* NotificationRecipients;
				const ownerId = userId();
				const caregiverId = userId();
				const pet = petId();
				yield* insertUser(sql, ownerId);
				yield* insertUser(sql, caregiverId);
				yield* insertPet(sql, pet, ownerId);
				yield* insertCaregiver(sql, pet, caregiverId, 'accepted');
				yield* insertIdentity(sql, otherBotId, ownerId, 301);
				yield* insertIdentity(sql, otherBotId, caregiverId, 302);
				return yield* recipients.resolvePetRecipients(botId, pet);
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result).toHaveLength(2);
			expect(result.map(({ resolution }) => resolution)).toEqual([
				expect.objectContaining({
					_tag: 'Unreachable',
					error: expect.objectContaining({ code: 'MissingTelegramIdentity' }),
				}),
				expect.objectContaining({
					_tag: 'Unreachable',
					error: expect.objectContaining({ code: 'MissingTelegramIdentity' }),
				}),
			]);
		});

		it('does not duplicate an owner also present as an accepted caregiver', async () => {
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const recipients = yield* NotificationRecipients;
				const ownerId = userId();
				const pet = petId();
				yield* insertUser(sql, ownerId);
				yield* insertPet(sql, pet, ownerId);
				yield* insertIdentity(sql, botId, ownerId, 401);
				yield* insertCaregiver(sql, pet, ownerId, 'accepted');
				return yield* recipients.resolvePetRecipients(botId, pet);
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({ role: 'owner' });
			expect(result[0]?.resolution).toMatchObject({
				_tag: 'Reachable',
				recipientChatId: Schema.decodeUnknownSync(TelegramChatId)(401),
			});
		});
	});

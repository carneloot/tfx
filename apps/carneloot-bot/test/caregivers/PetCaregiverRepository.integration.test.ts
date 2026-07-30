import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import { migrate } from '../../src/postgres/AppMigrator.js';
import * as PetCaregiverRepositoryLive from '../../src/postgres/PetCaregiverRepositoryLive.js';
import * as PetRepositoryLive from '../../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapters = Layer.mergeAll(
	UserRepositoryLive.layer,
	PetRepositoryLive.layer,
	PetCaregiverRepositoryLive.layer,
).pipe(
	Layer.provideMerge(
		Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
	),
);
const botId = Schema.decodeUnknownSync(BotId)('caregiver-tests');
const otherBotId = Schema.decodeUnknownSync(BotId)('caregiver-tests-other');
const profile = (bot: BotId, telegramId: number, username: string) => ({
	botId: bot,
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
	username,
	firstName: username,
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
});

const names = (pets: ReadonlyArray<{ readonly name: string }>) =>
	pets.map((pet) => pet.name);

describe.skipIf(!enabled)('caregiver PostgreSQL repositories', () => {
	it('persists every status, removes relationships, and cascades pet deletion', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const sql = yield* PgClient.PgClient;
			const users = yield* UserRepository;
			const pets = yield* PetRepository;
			const caregivers = yield* PetCaregiverRepository;
			const owner = yield* users.registerTelegramProfile(
				profile(botId, 81001, 'OwnerStatus'),
			);
			const pendingUser = yield* users.registerTelegramProfile(
				profile(botId, 81002, 'PendingStatus'),
			);
			const acceptedUser = yield* users.registerTelegramProfile(
				profile(botId, 81003, 'AcceptedStatus'),
			);
			const rejectedUser = yield* users.registerTelegramProfile(
				profile(botId, 81004, 'RejectedStatus'),
			);
			const pet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Status Pet'),
			);
			const now = yield* DateTime.now;
			yield* caregivers.insertPending(pet.id, pendingUser.user.id, now);
			yield* caregivers.insertPending(pet.id, acceptedUser.user.id, now);
			yield* caregivers.insertPending(pet.id, rejectedUser.user.id, now);
			yield* caregivers.setPendingResponse(
				pet.id,
				acceptedUser.user.id,
				'accepted',
				now,
			);
			yield* caregivers.setPendingResponse(
				pet.id,
				rejectedUser.user.id,
				'rejected',
				now,
			);

			const duplicate = yield* Effect.result(
				caregivers.insertPending(pet.id, pendingUser.user.id, now),
			);
			const repeated = yield* Effect.result(
				caregivers.setPendingResponse(
					pet.id,
					acceptedUser.user.id,
					'rejected',
					now,
				),
			);
			const all = yield* caregivers.listForPet(pet.id);
			const pending = yield* caregivers.listPendingForUser(pendingUser.user.id);
			const accepted = yield* caregivers.listAcceptedForUser(
				acceptedUser.user.id,
			);
			const rejectedPending = yield* caregivers.listPendingForUser(
				rejectedUser.user.id,
			);
			const rejectedAccepted = yield* caregivers.listAcceptedForUser(
				rejectedUser.user.id,
			);
			const removed = [
				yield* caregivers.remove(pet.id, pendingUser.user.id),
				yield* caregivers.remove(pet.id, acceptedUser.user.id),
				yield* caregivers.remove(pet.id, rejectedUser.user.id),
				yield* caregivers.remove(pet.id, rejectedUser.user.id),
			];

			const cascadePet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Cascade Pet'),
			);
			yield* caregivers.insertPending(cascadePet.id, pendingUser.user.id, now);
			yield* sql`DELETE FROM carneloot.pets WHERE id=${cascadePet.id}::uuid`;

			return {
				all,
				pending,
				accepted,
				rejectedPending,
				rejectedAccepted,
				removed,
				duplicate,
				repeated,
				cascadeRelationship: yield* caregivers.find(
					cascadePet.id,
					pendingUser.user.id,
				),
			};
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(
			result.all.map((relationship) => relationship.status).sort(),
		).toEqual(['accepted', 'pending', 'rejected']);
		expect(result.pending).toHaveLength(1);
		expect(result.pending[0]?.status).toBe('pending');
		expect(result.accepted).toHaveLength(1);
		expect(result.accepted[0]?.status).toBe('accepted');
		expect(result.rejectedPending).toEqual([]);
		expect(result.rejectedAccepted).toEqual([]);
		expect(result.removed).toEqual([true, true, true, false]);
		expect(result.duplicate).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'CaregiverRelationshipExists' },
		});
		expect(result.repeated).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'CaregiverInvitationNotPending' },
		});
		expect(result.cascadeRelationship).toBeUndefined();
	});

	it('grants accepted access only and deduplicates owned pets in name order', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const pets = yield* PetRepository;
			const caregivers = yield* PetCaregiverRepository;
			const owner = yield* users.registerTelegramProfile(
				profile(botId, 81101, 'AccessOwner'),
			);
			const caregiver = yield* users.registerTelegramProfile(
				profile(botId, 81102, 'AccessCaregiver'),
			);
			const acceptedPet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Bravo'),
			);
			const pendingPet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Charlie'),
			);
			const rejectedPet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Delta'),
			);
			const ownFirst = yield* pets.addOwned(
				caregiver.user.id,
				Schema.decodeUnknownSync(PetName)('Alpha'),
			);
			const ownLast = yield* pets.addOwned(
				caregiver.user.id,
				Schema.decodeUnknownSync(PetName)('Echo'),
			);
			const now = yield* DateTime.now;
			yield* caregivers.insertPending(acceptedPet.id, caregiver.user.id, now);
			yield* caregivers.setPendingResponse(
				acceptedPet.id,
				caregiver.user.id,
				'accepted',
				now,
			);
			yield* caregivers.insertPending(pendingPet.id, caregiver.user.id, now);
			yield* caregivers.insertPending(rejectedPet.id, caregiver.user.id, now);
			yield* caregivers.setPendingResponse(
				rejectedPet.id,
				caregiver.user.id,
				'rejected',
				now,
			);
			// An accepted self-relationship must not duplicate an already-owned pet.
			yield* caregivers.insertPending(ownLast.id, caregiver.user.id, now);
			yield* caregivers.setPendingResponse(
				ownLast.id,
				caregiver.user.id,
				'accepted',
				now,
			);
			return {
				beforeRemoval: yield* pets.listAccessible(caregiver.user.id),
				removed: yield* caregivers.remove(acceptedPet.id, caregiver.user.id),
				afterRemoval: yield* pets.listAccessible(caregiver.user.id),
				ownFirst,
			};
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(names(result.beforeRemoval)).toEqual(['Alpha', 'Bravo', 'Echo']);
		expect(result.beforeRemoval).toHaveLength(3);
		expect(result.removed).toBe(true);
		expect(names(result.afterRemoval)).toEqual(['Alpha', 'Echo']);
	});

	it('finds usernames case-insensitively within one bot, including zero and multiple matches', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const first = yield* users.registerTelegramProfile(
				profile(botId, 81201, 'SharedCase'),
			);
			const second = yield* users.registerTelegramProfile(
				profile(botId, 81202, 'sharedcase'),
			);
			yield* users.registerTelegramProfile(
				profile(otherBotId, 81203, 'SHAREDCASE'),
			);
			return {
				matches: yield* users.findByUsername(botId, ' @sHaReDcAsE '),
				none: yield* users.findByUsername(botId, 'missing-user'),
				first,
				second,
			};
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.matches.map(({ user }) => user.id)).toEqual(
			[result.first.user.id, result.second.user.id].sort(),
		);
		expect(result.none).toEqual([]);
	});
});

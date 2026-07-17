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
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapters = Layer.mergeAll(
	UserRepositoryLive.layer,
	PetRepositoryLive.layer,
	PetCaregiverRepositoryLive.layer,
).pipe(Layer.provideMerge(PostgresTestLayer.layer));
const botId = Schema.decodeUnknownSync(BotId)('caregiver-tests');
const profile = (telegramId: number, username: string) => ({
	botId,
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
	username,
	firstName: username,
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
});

describe.skipIf(!enabled)('caregiver PostgreSQL repositories', () => {
	it('persists transitions and grants access only when accepted', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const users = yield* UserRepository;
			const pets = yield* PetRepository;
			const caregivers = yield* PetCaregiverRepository;
			const owner = yield* users.registerTelegramProfile(
				profile(81001, 'OwnerCase'),
			);
			const caregiver = yield* users.registerTelegramProfile(
				profile(81002, 'SharedCase'),
			);
			const other = yield* users.registerTelegramProfile(
				profile(81003, 'sharedcase'),
			);
			const pet = yield* pets.addOwned(
				owner.user.id,
				Schema.decodeUnknownSync(PetName)('Zelda'),
			);
			const ownPet = yield* pets.addOwned(
				caregiver.user.id,
				Schema.decodeUnknownSync(PetName)('Alfa'),
			);
			const now = yield* DateTime.now;
			const pending = yield* caregivers.insertPending(
				pet.id,
				caregiver.user.id,
				now,
			);
			const before = yield* pets.listAccessible(caregiver.user.id);
			const duplicate = yield* Effect.result(
				caregivers.insertPending(pet.id, caregiver.user.id, now),
			);
			const accepted = yield* caregivers.setPendingResponse(
				pet.id,
				caregiver.user.id,
				'accepted',
				now,
			);
			const repeated = yield* Effect.result(
				caregivers.setPendingResponse(
					pet.id,
					caregiver.user.id,
					'rejected',
					now,
				),
			);
			return {
				pending,
				accepted,
				before,
				after: yield* pets.listAccessible(caregiver.user.id),
				duplicate,
				repeated,
				matches: yield* users.findByUsername(botId, ' @SHAREDCASE '),
				removed: yield* caregivers.remove(pet.id, caregiver.user.id),
				removedAgain: yield* caregivers.remove(pet.id, caregiver.user.id),
				ownPet,
				other,
			};
		});
		const result = await Effect.runPromise(Effect.provide(program, adapters));
		expect(result.pending.status).toBe('pending');
		expect(result.accepted.status).toBe('accepted');
		expect(result.before.map((pet) => pet.name)).toEqual(['Alfa']);
		expect(result.after.map((pet) => pet.name)).toEqual(['Alfa', 'Zelda']);
		expect(result.duplicate).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'CaregiverRelationshipExists' },
		});
		expect(result.repeated).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'CaregiverInvitationNotPending' },
		});
		expect(result.matches).toHaveLength(2);
		expect(result.removed).toBe(true);
		expect(result.removedAgain).toBe(false);
	});
});

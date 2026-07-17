import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as InviteCaregiver from '../../src/application/InviteCaregiver.js';
import { CaregiverSelfInvitation, CaregiverUsernameAmbiguous, CaregiverUsernameNotFound } from '../../src/domain/caregivers/CaregiverError.js';
import { BotId, PetId, TelegramChatId, TelegramUserId, UserId } from '../../src/domain/Ids.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const id = <A>(schema: Schema.Schema<A>, value: string | number) => Schema.decodeUnknownSync(schema)(value);
const ownerId = id(UserId, '00000000-0000-4000-8000-000000000001');
const caregiverId = id(UserId, '00000000-0000-4000-8000-000000000002');
const petId = id(PetId, '00000000-0000-4000-8000-000000000003');
const botId = id(BotId, 'caregiver-test');
const telegramUserId = id(TelegramUserId, 101);
const now = DateTime.makeUnsafe('2026-07-16T10:00:00Z');
const registered = (userId: typeof ownerId, telegramId: number, firstName: string) => ({ user: { id: userId, createdAt: now, updatedAt: now }, profile: { botId, telegramUserId: id(TelegramUserId, telegramId), username: firstName.toLowerCase(), firstName, lastName: null, privateChatId: id(TelegramChatId, telegramId) } });
const owner = registered(ownerId, 101, 'Owner');
const caregiver = registered(caregiverId, 202, 'Caregiver');

const runInvite = (matches: ReadonlyArray<typeof owner>, username = ' @CaReGiVeR ') => {
	let queried = '';
	const users = { registerTelegramProfile: () => Effect.die('unused'), findByTelegram: () => Effect.succeed(owner), findById: () => Effect.succeed(caregiver), findByUsername: (_bot: typeof botId, value: string) => { queried = value; return Effect.succeed(matches); } };
	const pets = { findById: () => Effect.die('unused'), lockById: () => Effect.succeed({ id: petId, ownerId, name: 'Luna', createdAt: now, updatedAt: now }), deleteOwned: () => Effect.die('unused'), addOwned: () => Effect.die('unused'), listOwned: () => Effect.die('unused'), listAccessible: () => Effect.die('unused') };
	const caregivers = { find: () => Effect.die('unused'), lock: () => Effect.die('unused'), insertPending: (_pet: typeof petId, userId: typeof ownerId) => Effect.succeed({ petId, caregiverUserId: userId, status: 'pending' as const, createdAt: now, updatedAt: now }), setPendingResponse: () => Effect.die('unused'), remove: () => Effect.die('unused'), listForPet: () => Effect.die('unused'), listPendingForUser: () => Effect.die('unused'), listAcceptedForUser: () => Effect.die('unused') };
	const client = { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect };
	const layer = Layer.mergeAll(Layer.succeed(UserRepository, users), Layer.succeed(PetRepository, pets), Layer.succeed(PetCaregiverRepository, caregivers), Layer.succeed(PgClient.PgClient, client as unknown as PgClient.PgClient));
	return { queried: () => queried, effect: InviteCaregiver.execute({ actorId: ownerId, botId, telegramUserId }, petId, username).pipe(Effect.provide(layer)) };
};

describe('caregiver application', () => {
	it('normalizes username, creates pending invite, and emits private notice', async () => {
		const fixture = runInvite([caregiver]);
		const result = await Effect.runPromise(fixture.effect);
		expect(fixture.queried()).toBe('caregiver');
		expect(result.value.status).toBe('pending');
		expect(result.notices).toEqual([{ chatId: caregiver.profile.privateChatId, text: 'Owner convidou você para cuidar do pet Luna.\nUse /convites_pet para responder.' }]);
	});
	it.each([[[], CaregiverUsernameNotFound], [[caregiver, caregiver], CaregiverUsernameAmbiguous], [[owner], CaregiverSelfInvitation]] as const)('rejects invalid invite target', async (matches, ErrorClass) => {
		const exit = await Effect.runPromiseExit(runInvite(matches).effect);
		expect(exit._tag).toBe('Failure');
		if (exit._tag === 'Failure') expect(String(exit.cause)).toContain(ErrorClass.name);
	});
	it('rejects empty username as not found', async () => {
		const exit = await Effect.runPromiseExit(runInvite([], ' @ ').effect);
		expect(exit._tag).toBe('Failure');
		expect(String(exit)).toContain('CaregiverUsernameNotFound');
	});
});

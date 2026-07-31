import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as InviteCaregiver from '../../src/application/InviteCaregiver.js';
import * as ListCaregivers from '../../src/application/ListCaregivers.js';
import * as ListPetInvitations from '../../src/application/ListPetInvitations.js';
import * as RemoveCaregiver from '../../src/application/RemoveCaregiver.js';
import * as RespondPetInvitation from '../../src/application/RespondPetInvitation.js';
import * as StopCaring from '../../src/application/StopCaring.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import {
	CaregiverAccessLost,
	CaregiverInvitationNotPending,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
	CaregiverUsernameNotFound,
} from '../../src/domain/caregivers/CaregiverError.js';
import type {
	CaregiverStatus,
	PetCaregiver,
} from '../../src/domain/caregivers/PetCaregiver.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import type { Pet } from '../../src/domain/Pet.js';
import type { RegisteredUser } from '../../src/domain/User.js';
import {
	PetCaregiverRepository,
	type PetCaregiverRepositoryService,
} from '../../src/ports/PetCaregiverRepository.js';
import {
	PetRepository,
	type PetRepositoryService,
} from '../../src/ports/PetRepository.js';
import {
	UserRepository,
	type UserRepositoryService,
} from '../../src/ports/UserRepository.js';

const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const caregiverId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000002',
);
const otherId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000004',
);
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('caregiver-test');
const ownerTelegramId = Schema.decodeUnknownSync(TelegramUserId)(101);
const caregiverTelegramId = Schema.decodeUnknownSync(TelegramUserId)(202);
const now = DateTime.makeUnsafe('2026-07-16T10:00:00Z');
const registered = (
	userId: UserId,
	telegramId: number,
	firstName: string,
): RegisteredUser => ({
	user: { id: userId, createdAt: now, updatedAt: now },
	profile: {
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
		username: firstName.toLowerCase(),
		firstName,
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
	},
});
const owner = registered(ownerId, 101, 'Owner');
const caregiver = registered(caregiverId, 202, 'Caregiver');
const other = registered(otherId, 303, 'Other');
const pet: Pet = {
	id: petId,
	ownerId,
	name: 'Luna',
	createdAt: now,
	updatedAt: now,
};
const actor = {
	actorId: caregiverId,
	botId,
	telegramUserId: caregiverTelegramId,
};
const ownerActor = { actorId: ownerId, botId, telegramUserId: ownerTelegramId };
const relation = (
	status: CaregiverStatus,
	userId = caregiverId,
): PetCaregiver => ({
	petId,
	caregiverUserId: userId,
	status,
	createdAt: now,
	updatedAt: now,
});

interface FixtureOptions {
	readonly current?: RegisteredUser;
	readonly pet?: Pet;
	readonly locked?: PetCaregiver;
	readonly listed?: ReadonlyArray<PetCaregiver>;
	readonly usernameMatches?: ReadonlyArray<RegisteredUser>;
	readonly removeResult?: boolean;
}

const fixture = (options: FixtureOptions = {}) => {
	let queried = '';
	let response: 'accepted' | 'rejected' | undefined;
	const current = options.current ?? caregiver;
	const locked = options.locked;
	const users: UserRepositoryService = {
		registerTelegramProfile: () => Effect.die('unused'),
		findByTelegram: (_bot, telegramId) =>
			Effect.succeed(
				options.current ?? (telegramId === ownerTelegramId ? owner : current),
			),
		findById: (_bot, userId) =>
			Effect.succeed(
				userId === ownerId ? owner : userId === caregiverId ? caregiver : other,
			),
		findByUsername: (_bot, value) => {
			queried = value;
			return Effect.succeed(options.usernameMatches ?? [caregiver]);
		},
	};
	const pets: PetRepositoryService = {
		findById: () => Effect.succeed(options.pet),
		lockById: () => Effect.succeed(options.pet),
		deleteOwned: () => Effect.die('unused'),
		addOwned: () => Effect.die('unused'),
		listOwned: () => Effect.die('unused'),
		listAccessible: () => Effect.die('unused'),
	};
	const caregivers: PetCaregiverRepositoryService = {
		find: () => Effect.succeed(locked),
		lock: () => Effect.succeed(locked),
		insertPending: (_pet, userId) =>
			Effect.succeed(relation('pending', userId)),
		setPendingResponse: (_pet, userId, status) => {
			response = status;
			return Effect.succeed(relation(status, userId));
		},
		remove: () => Effect.succeed(options.removeResult ?? true),
		listForPet: () => Effect.succeed(options.listed ?? []),
		listPendingForUser: () => Effect.succeed(options.listed ?? []),
		listAcceptedForUser: () => Effect.succeed(options.listed ?? []),
	};
	const layer = Layer.mergeAll(
		Layer.succeed(CurrentUser, current),
		Layer.succeed(UserRepository, users),
		Layer.succeed(PetRepository, pets),
		Layer.succeed(PetCaregiverRepository, caregivers),
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		} as unknown as PgClient.PgClient),
	);
	return {
		queried: () => queried,
		response: () => response,
		provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provide(layer)),
	};
};

const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
	const exit = await Effect.runPromiseExit(effect);
	return exit._tag === 'Failure' ? String(exit.cause) : '';
};

describe('caregiver application', () => {
	it('invites normalized username and rejects missing, ambiguous, or self targets', async () => {
		const success = fixture({
			pet,
			current: owner,
			usernameMatches: [caregiver],
		});
		const result = await Effect.runPromise(
			success.provide(
				InviteCaregiver.execute(ownerActor, petId, ' @CaReGiVeR '),
			),
		);
		expect(success.queried()).toBe('caregiver');
		expect(result.value.status).toBe('pending');
		expect(result.notices[0]?.chatId).toBe(caregiver.profile.privateChatId);
		for (const [matches, ErrorClass] of [
			[[], CaregiverUsernameNotFound],
			[[caregiver, other], CaregiverUsernameAmbiguous],
			[[owner], CaregiverSelfInvitation],
		] as const) {
			expect(
				await failure(
					fixture({ pet, current: owner, usernameMatches: matches }).provide(
						InviteCaregiver.execute(ownerActor, petId, '@target'),
					),
				),
			).toContain(ErrorClass.name);
		}
	});

	it.each(['accepted', 'rejected'] as const)(
		'responds %s to pending invitation',
		async (status) => {
			const test = fixture({ pet, locked: relation('pending') });
			const result = await Effect.runPromise(
				test.provide(RespondPetInvitation.execute(actor, petId, status)),
			);
			expect(test.response()).toBe(status);
			expect(result.value.status).toBe(status);
			expect(result.notices[0]?.chatId).toBe(owner.profile.privateChatId);
		},
	);

	it('rejects repeated invitation response', async () => {
		expect(
			await failure(
				fixture({ pet, locked: relation('accepted') }).provide(
					RespondPetInvitation.execute(actor, petId, 'rejected'),
				),
			),
		).toContain(CaregiverInvitationNotPending.name);
	});

	it.each(['pending', 'accepted', 'rejected'] as const)(
		'owner removes %s relationship',
		async (status) => {
			const result = await Effect.runPromise(
				fixture({ pet, current: owner, locked: relation(status) }).provide(
					RemoveCaregiver.execute(ownerActor, petId, caregiverId),
				),
			);
			expect(result.value.status).toBe(status);
			expect(result.notices[0]?.chatId).toBe(caregiver.profile.privateChatId);
		},
	);

	it('lists caregivers with display names and Portuguese status labels', async () => {
		const listed = [
			relation('pending'),
			relation('accepted', otherId),
			relation('rejected'),
		];
		const result = await Effect.runPromise(
			fixture({ pet, current: owner, listed }).provide(
				ListCaregivers.execute(ownerActor, petId),
			),
		);
		expect(
			result.map(({ displayName, statusLabel }) => [displayName, statusLabel]),
		).toEqual([
			['Caregiver', 'pendente'],
			['Other', 'aceito'],
			['Caregiver', 'rejeitado'],
		]);
	});

	it('lists only locked pending invitations', async () => {
		const pending = relation('pending');
		const result = await Effect.runPromise(
			fixture({ pet, locked: pending, listed: [pending] }).provide(
				ListPetInvitations.execute(actor),
			),
		);
		expect(result).toEqual([
			{ relation: pending, pet, ownerDisplayName: 'Owner' },
		]);
	});

	it('stops caring only from accepted status', async () => {
		const result = await Effect.runPromise(
			fixture({ pet, locked: relation('accepted') }).provide(
				StopCaring.execute(actor, petId),
			),
		);
		expect(result.value.status).toBe('accepted');
		for (const status of ['pending', 'rejected'] as const) {
			expect(
				await failure(
					fixture({ pet, locked: relation(status) }).provide(
						StopCaring.execute(actor, petId),
					),
				),
			).toContain(CaregiverInvitationNotPending.name);
		}
	});

	it('enforces owner isolation', async () => {
		const foreignPet = { ...pet, ownerId: otherId };
		expect(
			await failure(
				fixture({ pet: foreignPet, locked: relation('accepted') }).provide(
					RemoveCaregiver.execute(ownerActor, petId, caregiverId),
				),
			),
		).toContain(CaregiverAccessLost.name);
		expect(
			await failure(
				fixture({ pet: foreignPet }).provide(
					ListCaregivers.execute(ownerActor, petId),
				),
			),
		).toContain(CaregiverAccessLost.name);
	});

	it('rejects revoked identity and access', async () => {
		const changedIdentity = fixture({
			current: other,
			pet,
			locked: relation('pending'),
		});
		expect(
			await failure(
				changedIdentity.provide(
					RespondPetInvitation.execute(actor, petId, 'accepted'),
				),
			),
		).toContain(CaregiverAccessLost.name);
		expect(
			await failure(
				fixture({
					locked: relation('pending'),
					listed: [relation('pending')],
				}).provide(ListPetInvitations.execute(actor)),
			),
		).toContain(CaregiverAccessLost.name);
	});
});

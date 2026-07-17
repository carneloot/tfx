import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import * as ConfigureDayStart from '../../src/application/ConfigureDayStart.js';
import * as ConfigureReminderDelay from '../../src/application/ConfigureReminderDelay.js';
import { authorize } from '../../src/application/PetFoodAccess.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const actorId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000003',
);
const access = {
	actorId,
	petId: Schema.decodeUnknownSync(PetId)(
		'00000000-0000-4000-8000-000000000002',
	),
	botId: Schema.decodeUnknownSync(BotId)('bot'),
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
};
const now = DateTime.makeUnsafe(0);
const pet = {
	id: access.petId,
	ownerId,
	name: Schema.decodeUnknownSync(PetName)('Mochi'),
	createdAt: now,
	updatedAt: now,
};
const unused = () => Effect.die('unused');
const authorizationLayers = (
	options: {
		readonly currentActorId?: UserId;
		readonly petExists?: boolean;
		readonly relationshipStatus?: 'pending' | 'accepted' | 'rejected';
	} = {},
) =>
	Layer.mergeAll(
		Layer.succeed(UserRepository, {
			registerTelegramProfile: unused,
			findById: () => Effect.die('unused'),
			findByUsername: unused,
			findByTelegram: () =>
				Effect.succeed({
					user: {
						id: options.currentActorId ?? actorId,
						createdAt: now,
						updatedAt: now,
					},
					profile: {
						botId: access.botId,
						telegramUserId: access.telegramUserId,
						username: null,
						firstName: 'Ana',
						lastName: null,
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
					},
				}),
		}),
		Layer.succeed(PetRepository, {
			findById: unused,
			lockById: () =>
				Effect.succeed(options.petExists === false ? undefined : pet),
			deleteOwned: unused,
			addOwned: unused,
			listOwned: unused,
			listAccessible: unused,
		}),
		Layer.succeed(PetCaregiverRepository, {
			find: unused,
			lock: () =>
				Effect.succeed(
					options.relationshipStatus === undefined
						? undefined
						: {
								petId: access.petId,
								caregiverUserId: actorId,
								status: options.relationshipStatus,
								createdAt: now,
								updatedAt: now,
							},
				),
			insertPending: unused,
			setPendingResponse: unused,
			remove: unused,
			listForPet: unused,
			listPendingForUser: unused,
			listAcceptedForUser: unused,
		}),
	);

const authorizeResult = (options?: Parameters<typeof authorizationLayers>[0]) =>
	Effect.runPromise(
		Effect.result(authorize(access)).pipe(
			Effect.provide(authorizationLayers(options)),
		),
	);

describe('pet food authorization', () => {
	it('authorizes owner access', async () => {
		const result = await Effect.runPromise(
			authorize({ ...access, actorId: ownerId }).pipe(
				Effect.provide(authorizationLayers({ currentActorId: ownerId })),
			),
		);
		expect(result).toMatchObject({ actorId: ownerId, ownerId, role: 'owner' });
	});

	it('authorizes accepted caregiver access', async () => {
		const result = await Effect.runPromise(
			authorize(access).pipe(
				Effect.provide(authorizationLayers({ relationshipStatus: 'accepted' })),
			),
		);
		expect(result).toMatchObject({ actorId, ownerId, role: 'caregiver' });
	});

	it.each(['pending', 'rejected'] as const)(
		'denies %s caregiver access',
		async (relationshipStatus) => {
			const result = await authorizeResult({ relationshipStatus });
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'PetAccessDenied' },
			});
		},
	);

	it('denies missing caregiver relationship', async () => {
		const result = await authorizeResult();
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'PetAccessDenied' },
		});
	});

	it('denies missing pet', async () => {
		const result = await authorizeResult({ petExists: false });
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'PetAccessDenied' },
		});
	});

	it('denies Telegram identity mismatch', async () => {
		const result = await authorizeResult({ currentActorId: ownerId });
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'PetAccessDenied',
				message: 'Telegram identity no longer matches actor',
			},
		});
	});
});

describe('pet food application validation', () => {
	it('rejects delay outside one millisecond through thirty days before SQL', async () => {
		for (const delay of [0, 2_592_000_001]) {
			const result = await Effect.runPromise(
				Effect.result(
					ConfigureReminderDelay.set(access, delay),
				) as Effect.Effect<any>,
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'InvalidDomainInput' },
			});
		}
	});
	it('rejects unsafe update id before SQL', async () => {
		const source = await Effect.runPromise(
			Effect.result(
				AddFood.execute(
					access,
					{
						amountMg: Schema.decodeUnknownSync(FoodAmount)('10g'),
						when: '10:00',
						messageDate: now,
					},
					{
						botId: 'bot',
						updateId: Number.MAX_SAFE_INTEGER + 1,
					},
				),
			) as Effect.Effect<any>,
		);
		expect(source).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'InvalidDomainInput' },
		});
	});
	it('maps day-start and timezone validation to domain input errors', async () => {
		for (const [dayStart, timeZone] of [
			['24:00', 'UTC'],
			['00:00', 'Not/AZone'],
		] as const) {
			const result = await Effect.runPromise(
				Effect.result(
					ConfigureDayStart.execute(access, dayStart, timeZone),
				) as Effect.Effect<any>,
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'InvalidDomainInput' },
			});
		}
	});
});

import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AddFoodToAll from '../../src/application/AddFoodToAll.js';
import { DomainPersistenceError } from '../../src/domain/DomainError.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import {
	IanaTimeZone,
	LocalTime,
} from '../../src/domain/pet-food/FoodDateTime.js';
import {
	FoodEntryId,
	type PetFoodEntry,
	type PetFoodSettings,
} from '../../src/domain/pet-food/PetFood.js';
import { PetName, type Pet } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import {
	PetFoodRepository,
	type NewFoodEntry,
} from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const actorId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const botId = Schema.decodeUnknownSync(BotId)('bot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const messageDate = DateTime.makeUnsafe('2025-01-02T01:30:00.000Z');
const input = {
	amountMg: Schema.decodeUnknownSync(FoodAmount)('50g'),
	when: '',
	messageDate,
};
const source = { botId, updateId: 777, messageChatId: 42, messageId: 9 };
const unused = () => Effect.die('unused');

const makePet = (index: number): Pet => ({
	id: Schema.decodeUnknownSync(PetId)(
		`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
	),
	ownerId: actorId,
	name: Schema.decodeUnknownSync(PetName)(`Pet ${index}`),
	createdAt: messageDate,
	updatedAt: messageDate,
});

interface FixtureOptions {
	readonly pets: ReadonlyArray<Pet>;
	readonly accessible?: ReadonlyArray<Pet>;
	readonly lostPetId?: PetId;
	readonly timeZones?: ReadonlyMap<PetId, string>;
	readonly failInsertOnceFor?: PetId;
}

const fixture = (options: FixtureOptions) => {
	const entries: PetFoodEntry[] = [];
	let failed = false;
	const settings = (petId: PetId): PetFoodSettings => ({
		petId,
		dayStart: Schema.decodeUnknownSync(LocalTime)('06:00'),
		timeZone: Schema.decodeUnknownSync(IanaTimeZone)(
			options.timeZones?.get(petId) ?? 'UTC',
		),
		reminderDelay: null,
		createdAt: messageDate,
		updatedAt: messageDate,
	});
	const layer = Layer.mergeAll(
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		} as unknown as PgClient.PgClient),
		Layer.succeed(UserRepository, {
			registerTelegramProfile: unused,
			findById: unused,
			findByUsername: unused,
			findByTelegram: () =>
				Effect.succeed({
					user: { id: actorId, createdAt: messageDate, updatedAt: messageDate },
					profile: {
						botId,
						telegramUserId,
						username: null,
						firstName: 'Actor',
						lastName: null,
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
					},
				}),
		}),
		Layer.succeed(PetRepository, {
			findById: unused,
			lockById: (petId: PetId) =>
				Effect.succeed(
					petId === options.lostPetId
						? undefined
						: options.pets.find((pet) => pet.id === petId),
				),
			deleteOwned: unused,
			addOwned: unused,
			listOwned: unused,
			listAccessible: () => Effect.succeed(options.accessible ?? options.pets),
		}),
		Layer.succeed(PetCaregiverRepository, {
			find: unused,
			lock: unused,
			insertPending: unused,
			setPendingResponse: unused,
			remove: unused,
			listForPet: unused,
			listPendingForUser: unused,
			listAcceptedForUser: unused,
		}),
		Layer.succeed(PetFoodRepository, {
			lockOwnedPet: unused,
			getSettings: (petId: PetId) => Effect.succeed(settings(petId)),
			setDayStart: unused,
			setReminderDelay: unused,
			clearReminderDelay: unused,
			latestEntry: (petId: PetId) =>
				Effect.succeed(entries.findLast((entry) => entry.petId === petId)),
			findBySource: (petId: PetId, sourceBotId: BotId, updateId: number) =>
				Effect.succeed(
					entries.find(
						(entry) =>
							entry.petId === petId &&
							entry.sourceBotId === sourceBotId &&
							entry.sourceUpdateId === updateId,
					),
				),
			findBusinessDuplicate: () => Effect.succeed(undefined),
			insert: (entry: NewFoodEntry) =>
				Effect.suspend(() => {
					if (entry.petId === options.failInsertOnceFor && !failed) {
						failed = true;
						return Effect.fail(
							new DomainPersistenceError({
								reason: 'PersistenceFailure',
								message: 'database unavailable',
							}),
						);
					}
					const stored: PetFoodEntry = {
						id: Schema.decodeUnknownSync(FoodEntryId)(entry.id),
						petId: entry.petId,
						recordedBy: entry.recordedBy,
						amountMg: entry.amountMg,
						fedAt: entry.fedAt,
						sourceBotId: entry.source.botId,
						sourceUpdateId: entry.source.updateId,
						sourceMessageChatId: entry.source.messageChatId,
						sourceMessageId: entry.source.messageId,
						createdAt: entry.now,
						updatedAt: entry.now,
					};
					entries.push(stored);
					return Effect.succeed(stored);
				}),
			status: unused,
		}),
		Layer.succeed(ReminderScheduler, {
			replaceForLatest: () => Effect.void,
			cancelForPet: () => Effect.void,
		}),
	);
	const run = (overrides: Partial<typeof input> = {}) =>
		Effect.runPromise(
			AddFoodToAll.execute(
				{ actorId, botId, telegramUserId },
				{ ...input, ...overrides },
				source,
			).pipe(Effect.provide(layer)),
		);
	return { entries, run };
};

describe('AddFoodToAll with real AddFood', () => {
	it('writes distinct pet rows with shared source and authenticated actor', async () => {
		const pets = [makePet(1), makePet(2)];
		const test = fixture({ pets });

		const result = await test.run();

		expect(result.items.map((item) => item._tag)).toEqual(['Added', 'Added']);
		expect(test.entries).toHaveLength(2);
		expect(new Set(test.entries.map((entry) => entry.petId))).toEqual(
			new Set(pets.map((pet) => pet.id)),
		);
		for (const entry of test.entries) {
			expect(entry.recordedBy).toBe(actorId);
			expect(entry.sourceBotId).toBe(botId);
			expect(entry.sourceUpdateId).toBe(source.updateId);
			expect(entry.sourceMessageChatId).toBe(42);
			expect(entry.sourceMessageId).toBe(9);
		}
	});

	it('maps access removed after listing to AccessLost without writing', async () => {
		const pets = [makePet(3)];
		const test = fixture({ pets, lostPetId: pets[0]!.id });

		const result = await test.run();

		expect(result.items).toMatchObject([{ _tag: 'AccessLost', pet: pets[0] }]);
		expect(test.entries).toEqual([]);
	});

	it('propagates infrastructure failure then converges by replay on retry', async () => {
		const pets = [makePet(4), makePet(5)];
		const test = fixture({ pets, failInsertOnceFor: pets[1]!.id });

		await expect(test.run()).rejects.toThrow('database unavailable');
		expect(test.entries.map((entry) => entry.petId)).toEqual([pets[0]!.id]);

		const retry = await test.run();
		expect(retry.items.map((item) => item._tag)).toEqual(['Replayed', 'Added']);
		expect(test.entries.map((entry) => entry.petId)).toEqual(
			pets.map((pet) => pet.id),
		);
	});

	it('anchors same time-only message independently in each pet timezone', async () => {
		const pets = [makePet(6), makePet(7)];
		const test = fixture({
			pets,
			timeZones: new Map([
				[pets[0]!.id, 'America/New_York'],
				[pets[1]!.id, 'Asia/Tokyo'],
			]),
		});

		await test.run({ when: '20:00' });

		expect(
			test.entries.map((entry) => DateTime.formatIso(entry.fedAt)),
		).toEqual(['2025-01-02T01:00:00.000Z', '2025-01-01T11:00:00.000Z']);
	});
});

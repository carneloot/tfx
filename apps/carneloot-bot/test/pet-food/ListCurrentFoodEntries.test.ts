import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it, vi } from 'vitest';

import * as ListCurrentFoodEntries from '../../src/application/ListCurrentFoodEntries.js';
import { DomainPersistenceError } from '../../src/domain/DomainError.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import { IanaTimeZone } from '../../src/domain/pet-food/FoodDateTime.js';
import {
	FoodEntryId,
	type PetFoodEntry,
} from '../../src/domain/pet-food/PetFood.js';
import type { RegisteredUser } from '../../src/domain/User.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const botId = Schema.decodeUnknownSync(BotId)('bot');
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000010',
);
const actorOne = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const actorTwo = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000002',
);
const utc = Schema.decodeUnknownSync(IanaTimeZone)('UTC');
const instant = (value: string) => DateTime.makeUnsafe(Date.parse(value));
const entry = (
	id: string,
	recordedBy: UserId,
	fedAt: string,
): PetFoodEntry => ({
	id: Schema.decodeUnknownSync(FoodEntryId)(id),
	petId,
	recordedBy,
	amountMg: Schema.decodeUnknownSync(FoodAmountMg)(10_000),
	fedAt: instant(fedAt),
	sourceBotId: botId,
	sourceUpdateId: 1,
	sourceMessageChatId: null,
	sourceMessageId: null,
	createdAt: instant(fedAt),
	updatedAt: instant(fedAt),
});
const registered = (
	id: UserId,
	firstName: string,
	lastName: string | null,
	username: string | null,
): RegisteredUser => ({
	user: {
		id,
		createdAt: instant('2026-01-01T00:00:00Z'),
		updatedAt: instant('2026-01-01T00:00:00Z'),
	},
	profile: {
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(1),
		username,
		firstName,
		lastName,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(1),
	},
});
const unused = () => Effect.die('unused');
const layer = (
	findById: (
		bot: BotId,
		id: UserId,
	) => Effect.Effect<RegisteredUser, DomainPersistenceError>,
) =>
	Layer.succeed(UserRepository, {
		registerTelegramProfile: unused,
		findByUsername: unused,
		findByTelegram: unused,
		findById,
	});

const first = entry(
	'00000000-0000-4000-8000-000000000101',
	actorOne,
	'2026-07-16T12:00:00Z',
);
const second = entry(
	'00000000-0000-4000-8000-000000000102',
	actorTwo,
	'2026-07-16T13:00:00Z',
);

describe('ListCurrentFoodEntries', () => {
	it('sorts by fedAt descending, then id ascending, and deduplicates actor lookups', async () => {
		const sameTimeLaterId = entry(
			'00000000-0000-4000-8000-000000000103',
			actorOne,
			'2026-07-16T13:00:00Z',
		);
		const findById = vi.fn((_bot: BotId, id: UserId) =>
			Effect.succeed(
				registered(id, id === actorOne ? 'Ana' : 'Bia', null, null),
			),
		);
		const result = await Effect.runPromise(
			ListCurrentFoodEntries.execute(botId, utc, [
				first,
				sameTimeLaterId,
				second,
				first,
			]).pipe(Effect.provide(layer(findById))),
		);
		expect(result.map(({ entry }) => entry.id)).toEqual([
			second.id,
			sameTimeLaterId.id,
			first.id,
			first.id,
		]);
		expect(findById).toHaveBeenCalledTimes(2);
	});

	it('formats timezone-local timestamps across a UTC day boundary', async () => {
		const timeZone =
			Schema.decodeUnknownSync(IanaTimeZone)('America/Sao_Paulo');
		const boundary = entry(
			'00000000-0000-4000-8000-000000000104',
			actorOne,
			'2026-07-17T01:30:00Z',
		);
		const [result] = await Effect.runPromise(
			ListCurrentFoodEntries.execute(botId, timeZone, [boundary]).pipe(
				Effect.provide(
					layer(() => Effect.succeed(registered(actorOne, 'Ana', null, null))),
				),
			),
		);
		expect(result?.localTimestamp).toBe('16/07/2026 22:30');
	});

	it('maps actor display from names without exposing username or Telegram ids', async () => {
		const [result] = await Effect.runPromise(
			ListCurrentFoodEntries.execute(botId, utc, [first]).pipe(
				Effect.provide(
					layer(() =>
						Effect.succeed(
							registered(actorOne, 'Ana', 'Silva', 'secret_handle'),
						),
					),
				),
			),
		);
		expect(result?.actorDisplay).toBe('Ana Silva');
		expect(JSON.stringify(result)).not.toContain('secret_handle');
		expect(result).not.toHaveProperty('actor');
	});

	it('propagates repository failures', async () => {
		const failure = new DomainPersistenceError({
			reason: 'PersistenceFailure',
			message: 'database unavailable',
		});
		const result = await Effect.runPromise(
			Effect.result(
				ListCurrentFoodEntries.execute(botId, utc, [first]).pipe(
					Effect.provide(layer(() => Effect.fail(failure))),
				),
			),
		);
		expect(result).toMatchObject({ _tag: 'Failure', failure });
	});
});

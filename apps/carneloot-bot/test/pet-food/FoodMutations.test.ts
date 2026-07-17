import { Duration, Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import * as ReconcileFoodReminder from '../../src/application/ReconcileFoodReminder.js';
import { BotId, PetId, UserId } from '../../src/domain/Ids.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import { FoodEntryId, type PetFoodEntry } from '../../src/domain/pet-food/PetFood.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';

const botId = Schema.decodeUnknownSync(BotId)('bot');
const petId = Schema.decodeUnknownSync(PetId)('00000000-0000-4000-8000-000000000001');
const ownerUserId = Schema.decodeUnknownSync(UserId)('00000000-0000-4000-8000-000000000002');
const actorId = Schema.decodeUnknownSync(UserId)('00000000-0000-4000-8000-000000000003');
const entry = (suffix: number, fedAt: number): PetFoodEntry => ({
	id: Schema.decodeUnknownSync(FoodEntryId)(`00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`),
	petId,
	recordedBy: actorId,
	amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
	fedAt: DateTime.makeUnsafe(fedAt),
	sourceBotId: botId,
	sourceUpdateId: suffix,
	sourceMessageChatId: null,
	sourceMessageId: null,
	createdAt: DateTime.makeUnsafe(0),
	updatedAt: DateTime.makeUnsafe(0),
});
const unused = () => Effect.die('unused');

const run = async (
	before: PetFoodEntry | undefined,
	latest: PetFoodEntry | undefined,
	delay: Duration.Duration | null,
) => {
	const calls: Array<{ type: 'replace' | 'cancel'; request: unknown }> = [];
	const repository = Layer.succeed(PetFoodRepository, {
		lockOwnedPet: unused,
		getSettings: () => Effect.succeed({
			petId,
			dayStart: null,
			timeZone: null,
			reminderDelay: delay,
			createdAt: DateTime.makeUnsafe(0),
			updatedAt: DateTime.makeUnsafe(0),
		}),
		setDayStart: unused,
		setReminderDelay: unused,
		clearReminderDelay: unused,
		latestEntry: () => Effect.succeed(latest),
		findBySource: unused,
		findBusinessDuplicate: unused,
		insert: unused,
		status: unused,
	});
	const scheduler = Layer.succeed(ReminderScheduler, {
		replaceForLatest: (request) => Effect.sync(() => { calls.push({ type: 'replace', request }); }),
		cancelForPet: (request) => Effect.sync(() => { calls.push({ type: 'cancel', request }); }),
	});
	await Effect.runPromise(ReconcileFoodReminder.reconcile({
		botId,
		ownerUserId,
		petId,
		before: before === undefined ? undefined : { id: before.id, fedAt: before.fedAt },
	}).pipe(Effect.provide(Layer.merge(repository, scheduler))));
	return calls;
};

describe('reminder reconciliation', () => {
	it('does nothing when latest identity and timestamp are unchanged', async () => {
		const latest = entry(1, 1_000);
		expect(await run(latest, latest, Duration.seconds(10))).toEqual([]);
	});

	it.each([
		['latest timestamp changed', entry(1, 1_000), entry(1, 2_000)],
		['backdated row becomes latest', entry(1, 1_000), entry(2, 2_000)],
		['latest moves behind previous row', entry(1, 2_000), entry(2, 1_500)],
		['latest deletion exposes previous row', entry(2, 2_000), entry(1, 1_000)],
	])('replaces reminder when %s', async (_name, before, latest) => {
		const calls = await run(before, latest, Duration.seconds(10));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			type: 'replace',
			request: { foodEntryId: latest.id, runAt: DateTime.makeUnsafe(DateTime.toEpochMillis(latest.fedAt) + 10_000) },
		});
	});

	it('does nothing when a changed backdated row remains non-latest', async () => {
		const latest = entry(1, 2_000);
		expect(await run(latest, latest, Duration.seconds(10))).toEqual([]);
	});

	it.each([
		['final deletion', entry(1, 1_000), undefined, Duration.seconds(10)],
		['reminders disabled', entry(1, 1_000), entry(2, 2_000), null],
	] as const)('cancels for %s', async (_name, before, latest, delay) => {
		expect(await run(before, latest, delay)).toEqual([
			{ type: 'cancel', request: { botId, petId } },
		]);
	});

	it('propagates scheduler failure', async () => {
		const repository = Layer.succeed(PetFoodRepository, {
			lockOwnedPet: unused, getSettings: () => Effect.succeed(undefined), setDayStart: unused,
			setReminderDelay: unused, clearReminderDelay: unused, latestEntry: () => Effect.succeed(undefined),
			findBySource: unused, findBusinessDuplicate: unused, insert: unused, status: unused,
		});
		const scheduler = Layer.succeed(ReminderScheduler, {
			replaceForLatest: unused,
			cancelForPet: () => Effect.fail(new Error('scheduler failed') as never),
		});
		const result = await Effect.runPromiseExit(ReconcileFoodReminder.reconcile({
			botId, ownerUserId, petId, before: { id: entry(1, 1_000).id, fedAt: DateTime.makeUnsafe(1_000) },
		}).pipe(Effect.provide(Layer.merge(repository, scheduler))));
		expect(result._tag).toBe('Failure');
	});
});

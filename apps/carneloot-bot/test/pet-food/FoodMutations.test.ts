import * as PgClient from '@effect/sql-pg/PgClient';
import { Duration, Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as CorrectFood from '../../src/application/CorrectFood.js';
import * as DeleteFood from '../../src/application/DeleteFood.js';
import * as ReconcileFoodReminder from '../../src/application/ReconcileFoodReminder.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import {
	FoodAmount,
	FoodAmountMg,
} from '../../src/domain/pet-food/FoodAmount.js';
import {
	FoodEntryId,
	type PetFoodEntry,
} from '../../src/domain/pet-food/PetFood.js';
import { FoodEntryNotFound } from '../../src/domain/pet-food/PetFoodError.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const botId = Schema.decodeUnknownSync(BotId)('bot');
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000001',
);
const ownerUserId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000002',
);
const actorId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000003',
);
const entry = (suffix: number, fedAt: number): PetFoodEntry => ({
	id: Schema.decodeUnknownSync(FoodEntryId)(
		`00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
	),
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
		getSettings: () =>
			Effect.succeed({
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
		listEntries: unused,
		lockEntry: unused,
		lockAccessibleBySourceMessage: unused,
		findBySource: unused,
		findBusinessDuplicate: unused,
		findBusinessDuplicateExcluding: unused,
		insert: unused,
		updateEntry: unused,
		deleteEntry: unused,
		status: unused,
	});
	const scheduler = Layer.succeed(ReminderScheduler, {
		replaceForLatest: (request) =>
			Effect.sync(() => {
				calls.push({ type: 'replace', request });
			}),
		cancelForPet: (request) =>
			Effect.sync(() => {
				calls.push({ type: 'cancel', request });
			}),
	});
	await Effect.runPromise(
		ReconcileFoodReminder.reconcile({
			botId,
			ownerUserId,
			petId,
			before:
				before === undefined
					? undefined
					: { id: before.id, fedAt: before.fedAt },
		}).pipe(Effect.provide(Layer.merge(repository, scheduler))),
	);
	return calls;
};

describe('food mutation errors', () => {
	it('uses one non-leaking error for an unavailable selected entry', () => {
		const error = new FoodEntryNotFound({
			message: 'Food entry was not found',
		});
		expect(error).toMatchObject({
			_tag: 'FoodEntryNotFound',
			message: 'Food entry was not found',
		});
	});
});

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
			request: {
				foodEntryId: latest.id,
				runAt: DateTime.makeUnsafe(
					DateTime.toEpochMillis(latest.fedAt) + 10_000,
				),
			},
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
			lockOwnedPet: unused,
			getSettings: () => Effect.succeed(undefined),
			setDayStart: unused,
			setReminderDelay: unused,
			clearReminderDelay: unused,
			latestEntry: () => Effect.succeed(undefined),
			listEntries: unused,
			lockEntry: unused,
			lockAccessibleBySourceMessage: unused,
			findBySource: unused,
			findBusinessDuplicate: unused,
			findBusinessDuplicateExcluding: unused,
			insert: unused,
			updateEntry: unused,
			deleteEntry: unused,
			status: unused,
		});
		const scheduler = Layer.succeed(ReminderScheduler, {
			replaceForLatest: unused,
			cancelForPet: () => Effect.fail(new Error('scheduler failed') as never),
		});
		const result = await Effect.runPromiseExit(
			ReconcileFoodReminder.reconcile({
				botId,
				ownerUserId,
				petId,
				before: { id: entry(1, 1_000).id, fedAt: DateTime.makeUnsafe(1_000) },
			}).pipe(Effect.provide(Layer.merge(repository, scheduler))),
		);
		expect(result._tag).toBe('Failure');
	});
});

describe('food mutation services', () => {
	const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
	const amount = (value: string) => Schema.decodeUnknownSync(FoodAmount)(value);
	const selected = entry(10, Date.parse('2024-01-02T10:00:00Z'));
	const ownerPet = {
		id: petId,
		ownerId: ownerUserId,
		name: Schema.decodeUnknownSync(PetName)('Mochi'),
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	};
	type Options = {
		role?: 'owner' | 'caregiver';
		status?: 'pending' | 'accepted' | 'rejected' | 'revoked';
		missing?: boolean;
		outsideDay?: boolean;
		duplicate?: boolean;
		updateMissing?: boolean;
		deleteMissing?: boolean;
	};
	const harness = (options: Options = {}) => {
		let current = options.missing
			? undefined
			: {
					...selected,
					fedAt: options.outsideDay
						? DateTime.makeUnsafe('2024-01-01T10:00:00Z')
						: selected.fedAt,
				};
		const calls: string[] = [];
		const pet =
			options.role === 'owner' ? { ...ownerPet, ownerId: actorId } : ownerPet;
		const repository = Layer.succeed(PetFoodRepository, {
			lockOwnedPet: unused,
			getSettings: () =>
				Effect.succeed({
					petId,
					dayStart: '00:00' as never,
					timeZone: 'UTC' as never,
					reminderDelay: null,
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				}),
			setDayStart: unused,
			setReminderDelay: unused,
			clearReminderDelay: unused,
			latestEntry: () => Effect.succeed(current),
			listEntries: unused,
			lockEntry: () => Effect.succeed(current),
			lockAccessibleBySourceMessage: unused,
			findBySource: unused,
			findBusinessDuplicate: unused,
			findBusinessDuplicateExcluding: () =>
				Effect.succeed(
					options.duplicate
						? entry(11, Date.parse('2024-01-02T11:30:20Z'))
						: undefined,
				),
			insert: unused,
			updateEntry: (_id, amountMg, fedAt, now) => {
				if (options.updateMissing || current === undefined)
					return Effect.succeed(undefined);
				current = { ...current, amountMg, fedAt, updatedAt: now };
				return Effect.succeed(current);
			},
			deleteEntry: () => {
				if (options.deleteMissing || current === undefined)
					return Effect.succeed(undefined);
				const deleted = current;
				current = undefined;
				return Effect.succeed(deleted);
			},
			status: unused,
		});
		const dependencies = Layer.mergeAll(
			Layer.succeed(CurrentUser, {
				user: {
					id: actorId,
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				},
				profile: {
					botId,
					telegramUserId,
					username: null,
					firstName: 'Ana',
					lastName: null,
					privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
				},
			}),
			repository,
			Layer.succeed(UserRepository, {
				registerTelegramProfile: unused,
				findById: unused,
				findByUsername: unused,
				findByTelegram: () =>
					Effect.succeed({
						user: {
							id: actorId,
							createdAt: DateTime.makeUnsafe(0),
							updatedAt: DateTime.makeUnsafe(0),
						},
						profile: {
							botId,
							telegramUserId,
							username: null,
							firstName: 'Ana',
							lastName: null,
							privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
						},
					}),
			}),
			Layer.succeed(PetRepository, {
				findById: unused,
				lockById: () => Effect.succeed(pet),
				deleteOwned: unused,
				addOwned: unused,
				listOwned: unused,
				listAccessible: unused,
			}),
			Layer.succeed(PetCaregiverRepository, {
				find: unused,
				lock: () =>
					Effect.succeed(
						options.status === 'revoked' || options.role === 'owner'
							? undefined
							: {
									petId,
									caregiverUserId: actorId,
									status: options.status ?? 'accepted',
									createdAt: DateTime.makeUnsafe(0),
									updatedAt: DateTime.makeUnsafe(0),
								},
					),
				insertPending: unused,
				setPendingResponse: unused,
				remove: unused,
				listForPet: unused,
				listPendingForUser: unused,
				listAcceptedForUser: unused,
			}),
			Layer.succeed(ReminderScheduler, {
				replaceForLatest: () => Effect.sync(() => calls.push('replace')),
				cancelForPet: () => Effect.sync(() => calls.push('cancel')),
			}),
			Layer.succeed(PgClient.PgClient, {
				withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
			} as unknown as PgClient.PgClient),
		);
		const access = { actorId, botId, telegramUserId, petId };
		const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provide(Layer.merge(dependencies, TestClock.layer())));
		return { access, calls, current: () => current, provide };
	};
	const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.andThen(
			TestClock.setTime(Date.parse('2024-01-02T12:00:00Z')),
			effect,
		);

	it.each(['owner', 'caregiver'] as const)(
		'corrects amount as %s',
		async (role) => {
			const h = harness({ role });
			const result = await Effect.runPromise(
				h.provide(
					atNow(
						CorrectFood.execute(h.access, selected.id, {
							correction: '75g',
							messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
						}),
					),
				),
			);
			expect(result.entry.amountMg).toEqual(amount('75g'));
			expect(result.entry.fedAt).toEqual(selected.fedAt);
		},
	);

	it('corrects time without changing amount and excludes selected row from duplicates', async () => {
		const h = harness({ role: 'owner' });
		const result = await Effect.runPromise(
			h.provide(
				atNow(
					CorrectFood.execute(h.access, selected.id, {
						correction: '11:30',
						messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
					}),
				),
			),
		);
		expect(result.entry.amountMg).toEqual(selected.amountMg);
		expect(DateTime.toEpochMillis(result.entry.fedAt)).toBe(
			Date.parse('2024-01-02T11:30:00Z'),
		);
	});

	it('rejects a duplicate other than selected entry', async () => {
		const h = harness({ role: 'owner', duplicate: true });
		const exit = await Effect.runPromiseExit(
			h.provide(
				atNow(
					CorrectFood.execute(h.access, selected.id, {
						correction: '11:30',
						messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
					}),
				),
			),
		);
		expect(String(exit)).toContain('DuplicateFoodEntry');
	});

	it.each(['pending', 'rejected', 'revoked'] as const)(
		'denies %s caregiver correction and deletion',
		async (status) => {
			for (const operation of ['correct', 'delete'] as const) {
				const h = harness({ status });
				const effect =
					operation === 'correct'
						? Effect.asVoid(
								CorrectFood.execute(h.access, selected.id, {
									correction: '75g',
									messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
								}),
							)
						: Effect.asVoid(DeleteFood.execute(h.access, selected.id));
				const exit = await Effect.runPromiseExit(h.provide(atNow(effect)));
				expect(String(exit)).toContain('PetAccessDenied');
			}
		},
	);

	it.each([
		['missing selection', { missing: true }],
		['deleted during correction', { updateMissing: true }],
		['outside current day', { outsideDay: true }],
	] as const)('hides correction target when %s', async (_label, options) => {
		const h = harness({ role: 'owner', ...options });
		const exit = await Effect.runPromiseExit(
			h.provide(
				atNow(
					CorrectFood.execute(h.access, selected.id, {
						correction: '75g',
						messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
					}),
				),
			),
		);
		expect(String(exit)).toContain('FoodEntryNotFound');
	});

	it.each(['owner', 'caregiver'] as const)(
		'deletes and reconciles reminder as %s',
		async (role) => {
			const h = harness({ role });
			const deleted = await Effect.runPromise(
				h.provide(atNow(DeleteFood.execute(h.access, selected.id))),
			);
			expect(deleted.id).toBe(selected.id);
			expect(h.current()).toBeUndefined();
			expect(h.calls).toEqual(['cancel']);
		},
	);

	it.each([
		['missing selection', { missing: true }],
		['deleted after lock', { deleteMissing: true }],
		['outside current day', { outsideDay: true }],
	] as const)('hides deletion target when %s', async (_label, options) => {
		const h = harness({ role: 'owner', ...options });
		const exit = await Effect.runPromiseExit(
			h.provide(atNow(DeleteFood.execute(h.access, selected.id))),
		);
		expect(String(exit)).toContain('FoodEntryNotFound');
	});
});

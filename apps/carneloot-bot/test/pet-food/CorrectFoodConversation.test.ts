import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Duration, Effect, Layer, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import * as CorrectFood from '../../src/bot/conversations/CorrectFoodConversation.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import {
	FoodEntryId,
	type PetFoodEntry,
} from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000002',
);
const entryId = Schema.decodeUnknownSync(FoodEntryId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const petName = Schema.decodeUnknownSync(PetName)('Rex');
const now = DateTime.makeUnsafe('2024-01-02T12:00:00Z');
const pet = {
	id: petId,
	ownerId,
	name: petName,
	nameKey: 'rex',
	createdAt: now,
	updatedAt: now,
};
const current = {
	user: { id: ownerId, createdAt: now, updatedAt: now },
	profile: {
		botId,
		telegramUserId,
		username: null,
		firstName: 'Ana',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
	},
};
const entry: PetFoodEntry = {
	id: entryId,
	petId,
	recordedBy: ownerId,
	amountMg: 50_000 as never,
	fedAt: DateTime.makeUnsafe('2024-01-02T10:00:00Z'),
	sourceBotId: botId,
	sourceUpdateId: 1,
	sourceMessageChatId: null,
	sourceMessageId: null,
	createdAt: now,
	updatedAt: now,
};
const scope = { botId: 'carneloot', chatId: 42, userId: 42 };
const startup = {
	actorId: ownerId,
	botId,
	telegramUserId,
	pets: [{ id: petId, name: petName }],
};

const harness = (hasEntry = true) => {
	const replies: string[] = [];
	const replyOptions: unknown[] = [];
	const entries: PetFoodEntry[] = hasEntry ? [entry] : [];
	const access = { value: true };
	const schedulerFails = { value: false };
	const outputFails = { value: false };
	const messageDate = { value: now };
	let updates = 0;
	const context: MessageContextService = {
		get message() {
			return {
				date: DateTime.toEpochMillis(messageDate.value) / 1000,
			} as never;
		},
		chatId: 42,
		messageId: 1,
		messageThreadId: undefined,
		businessConnectionId: undefined,
		reply: (text, options) =>
			Effect.suspend(() => {
				if (outputFails.value && text.includes('sucesso'))
					return Effect.die('output failed');
				replies.push(text);
				replyOptions.push(options);
				return Effect.succeed({} as never);
			}),
		replyToCurrent: () => Effect.die('unused'),
		react: () => Effect.succeed(true),
		editText: () => Effect.die('unused'),
		delete: () => Effect.succeed(true),
		sendChatAction: () => Effect.succeed(true),
	};
	const food = {
		lockOwnedPet: () => Effect.die('unused'),
		getSettings: () =>
			Effect.succeed({
				petId,
				dayStart: '00:00',
				timeZone: 'UTC',
				reminderDelay: Duration.minutes(30),
				createdAt: now,
				updatedAt: now,
			}),
		setDayStart: () => Effect.die('unused'),
		setReminderDelay: () => Effect.die('unused'),
		clearReminderDelay: () => Effect.die('unused'),
		latestEntry: () => Effect.succeed(entries.at(-1)),
		findBySource: () => Effect.die('unused'),
		findBusinessDuplicate: () => Effect.die('unused'),
		findBusinessDuplicateExcluding: () => Effect.succeed(undefined),
		insert: () => Effect.die('unused'),
		listEntries: () => Effect.succeed([...entries]),
		lockEntry: (_p: unknown, id: typeof entryId) =>
			Effect.succeed(entries.find((x) => x.id === id)),
		lockAccessibleBySourceMessage: () => Effect.die('unused'),
		updateEntry: (
			id: typeof entryId,
			amountMg: PetFoodEntry['amountMg'],
			fedAt: DateTime.Utc,
			updatedAt: DateTime.Utc,
		) =>
			Effect.sync(() => {
				const index = entries.findIndex((x) => x.id === id);
				if (index < 0) return undefined;
				updates++;
				const updated = { ...entries[index]!, amountMg, fedAt, updatedAt };
				entries[index] = updated;
				return updated;
			}),
		deleteEntry: () => Effect.die('unused'),
		status: () => Effect.die('unused'),
	};
	const layer = Layer.mergeAll(
		MemoryStorage.layer,
		TestClock.layer(),
		Layer.succeed(MessageContext, context),
		Layer.succeed(CurrentUser, current),
		Layer.succeed(Telegram, {} as never),
		Layer.succeed(UserRepository, {
			registerTelegramProfile: () => Effect.die('unused'),
			findByTelegram: () => Effect.succeed(current),
			findById: () => Effect.succeed(current),
			findByUsername: () => Effect.die('unused'),
		}),
		Layer.succeed(PetRepository, {
			findById: () => Effect.die('unused'),
			lockById: () => Effect.succeed(access.value ? pet : undefined),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.die('unused'),
			listAccessible: () => Effect.die('unused'),
		}),
		Layer.succeed(PetCaregiverRepository, {
			find: () => Effect.die('unused'),
			lock: () => Effect.succeed(undefined),
			insertPending: () => Effect.die('unused'),
			setPendingResponse: () => Effect.die('unused'),
			remove: () => Effect.die('unused'),
			listForPet: () => Effect.die('unused'),
			listPendingForUser: () => Effect.die('unused'),
			listAcceptedForUser: () => Effect.die('unused'),
		}),
		Layer.succeed(PetFoodRepository, food as never),
		Layer.succeed(ReminderScheduler, {
			cancelForPet: () => Effect.void,
			replaceForLatest: () =>
				schedulerFails.value ? Effect.die('scheduler failed') : Effect.void,
		} as never),
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
				const snapshot = [...entries];
				const count = updates;
				return Effect.onError(effect, () =>
					Effect.sync(() => {
						entries.splice(0, entries.length, ...snapshot);
						updates = count;
					}),
				);
			},
		} as never),
	);
	return {
		replies,
		replyOptions,
		entries,
		access,
		schedulerFails,
		outputFails,
		messageDate,
		get updates() {
			return updates;
		},
		layer,
	};
};
const fresh = <A, E, R>(effect: Effect.Effect<A, E, R | Conversations>) =>
	Effect.provide(effect, Layer.fresh(ConversationsLive.layer));
const start = () =>
	Effect.andThen(
		TestClock.setTime(DateTime.toEpochMillis(now)),
		fresh(
			Effect.flatMap(Conversations, (s) =>
				s.start(CorrectFood.built, startup, { scope, conflict: 'replace' }),
			),
		),
	);
const resume = (input: string, updateId: number) =>
	fresh(
		Effect.flatMap(Conversations, (s) =>
			s.resume(CorrectFood.built, input, { scope, updateId }),
		),
	);
const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
	Effect.runPromise(effect as Effect.Effect<A, E>);
const label = '50 g — 02/01/2024 10:00 — Ana';

describe('CorrectFoodConversation', () => {
	it('completes cleanly when current day is empty', async () => {
		const h = harness(false);
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
				}),
				h.layer,
			),
		);
		expect(h.replies).toContain(
			'Não há registros de ração hoje para este pet.',
		);
		expect(h.replyOptions.at(-1)).toEqual({
			reply_markup: { remove_keyboard: true },
		});
	});

	it('supports Cancelar without correcting', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume('Cancelar', 2);
				}),
				h.layer,
			),
		);
		expect(h.updates).toBe(0);
		expect(h.replies).toContain('Operação cancelada.');
		expect(h.replyOptions.at(-1)).toEqual({
			reply_markup: { remove_keyboard: true },
		});
	});

	it('renders choice keyboards and removes entry keyboard before correction', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
				}),
				h.layer,
			),
		);
		expect(h.replyOptions).toEqual([
			{
				reply_markup: {
					keyboard: [[{ text: 'Rex' }], [{ text: 'Cancelar' }]],
					one_time_keyboard: true,
					resize_keyboard: true,
				},
			},
			{
				reply_markup: {
					keyboard: [[{ text: label }], [{ text: 'Cancelar' }]],
					one_time_keyboard: true,
					resize_keyboard: true,
				},
			},
			{ reply_markup: { remove_keyboard: true } },
		]);
	});

	it('keeps correction step active after invalid correction', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
					yield* resume('inválido', 3);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('correction');
				}),
				h.layer,
			),
		);
		expect(h.updates).toBe(0);
	});

	it('resumes persisted correction after service restart', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('correction');
					yield* resume('75g', 3);
				}),
				h.layer,
			),
		);
		expect(h.entries[0]?.amountMg).toBe(75_000);
	});

	it('reauthorizes access immediately before mutation', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
					h.access.value = false;
					yield* resume('75g', 3);
				}),
				h.layer,
			),
		);
		expect(h.updates).toBe(0);
		expect(h.replies).toContain('Este pet não está mais disponível para você.');
		expect(h.replyOptions.at(-1)).toEqual({
			reply_markup: { remove_keyboard: true },
		});
	});

	it('anchors time correction to MessageContext.message.date', async () => {
		const h = harness();
		h.messageDate.value = DateTime.makeUnsafe('2024-01-03T15:00:00Z');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
					yield* resume('08:30', 3);
				}),
				h.layer,
			),
		);
		expect(DateTime.formatIso(h.entries[0]!.fedAt)).toBe(
			'2024-01-03T08:30:00.000Z',
		);
	});

	it('updates in transaction and emits success only afterCommit', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					yield* resume(label, 2);
					yield* resume('75g', 3);
				}),
				h.layer,
			),
		);
		expect(h.entries[0]?.amountMg).toBe(75_000);
		expect(h.replies).toContain('Ração alterada com sucesso!');
		expect(h.replyOptions.at(-1)).toEqual({
			reply_markup: { remove_keyboard: true },
		});
	});

	it('rolls mutation back when transactional reminder mutation fails', async () => {
		const h = harness();
		h.schedulerFails.value = true;
		const exit = await run(
			Effect.provide(
				Effect.exit(
					Effect.gen(function* () {
						yield* start();
						yield* resume('Rex', 1);
						yield* resume(label, 2);
						yield* resume('08:30', 3);
					}),
				),
				h.layer,
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(h.entries).toEqual([entry]);
		expect(h.updates).toBe(0);
		expect(h.replies).not.toContain('Ração alterada com sucesso!');
	});

	it('does not roll committed correction back when afterCommit output fails', async () => {
		const h = harness();
		h.outputFails.value = true;
		const exit = await run(
			Effect.provide(
				Effect.exit(
					Effect.gen(function* () {
						yield* start();
						yield* resume('Rex', 1);
						yield* resume(label, 2);
						yield* resume('75g', 3);
					}),
				),
				h.layer,
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(h.entries[0]?.amountMg).toBe(75_000);
		expect(h.updates).toBe(1);
	});
});

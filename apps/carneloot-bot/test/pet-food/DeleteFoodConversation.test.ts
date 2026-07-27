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

import * as DeleteFood from '../../src/bot/conversations/DeleteFoodConversation.js';
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
import {
	ReminderScheduler,
	ReminderSchedulerError,
} from '../../src/ports/ReminderScheduler.js';
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
	const entries: PetFoodEntry[] = hasEntry ? [entry] : [];
	const access = { value: true };
	const schedulerFails = { value: false };
	const outputFails = { value: false };
	let deletes = 0;
	const context: MessageContextService = {
		message: { date: DateTime.toEpochMillis(now) / 1000 } as never,
		chatId: 42,
		messageId: 1,
		messageThreadId: undefined,
		businessConnectionId: undefined,
		reply: (text) =>
			Effect.suspend(() => {
				if (outputFails.value && text.includes('sucesso'))
					return Effect.die('output failed');
				replies.push(text);
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
		findBusinessDuplicateExcluding: () => Effect.die('unused'),
		insert: () => Effect.die('unused'),
		listEntries: () => Effect.succeed([...entries]),
		lockEntry: (_p: unknown, id: typeof entryId) =>
			Effect.succeed(entries.find((x) => x.id === id)),
		lockAccessibleBySourceMessage: () => Effect.die('unused'),
		updateEntry: () => Effect.die('unused'),
		deleteEntry: (id: typeof entryId) =>
			Effect.sync(() => {
				const index = entries.findIndex((x) => x.id === id);
				if (index < 0) return undefined;
				deletes++;
				return entries.splice(index, 1)[0];
			}),
		status: () => Effect.die('unused'),
	};
	const layer = Layer.mergeAll(
		MemoryStorage.layer,
		TestClock.layer(),
		Layer.succeed(MessageContext, context),
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
			cancelForPet: () =>
				schedulerFails.value
					? Effect.fail(
							new ReminderSchedulerError({
								reason: 'PersistenceFailure',
								message: 'scheduler failed',
							}),
						)
					: Effect.void,
			replaceForLatest: () => Effect.void,
		} as never),
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
				const snapshot = [...entries];
				const count = deletes;
				return Effect.onError(effect, () =>
					Effect.sync(() => {
						entries.splice(0, entries.length, ...snapshot);
						deletes = count;
					}),
				);
			},
		} as never),
	);
	return {
		replies,
		entries,
		access,
		schedulerFails,
		outputFails,
		get deletes() {
			return deletes;
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
				s.start(DeleteFood.built, startup, { scope, conflict: 'replace' }),
			),
		),
	);
const resume = (input: string, updateId: number) =>
	fresh(
		Effect.flatMap(Conversations, (s) =>
			s.resume(DeleteFood.built, input, { scope, updateId }),
		),
	);
const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
	Effect.runPromise(effect as Effect.Effect<A, E>);
const label = '50 g — 02/01/2024 10:00 — Ana';

describe('DeleteFoodConversation', () => {
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
	});

	it('supports Cancelar without deleting', async () => {
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
		expect(h.deletes).toBe(0);
		expect(h.replies).toContain('Operação cancelada.');
	});

	it('resumes persisted entry selection after service restart', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('entry');
					yield* resume(label, 2);
				}),
				h.layer,
			),
		);
		expect(h.deletes).toBe(1);
	});

	it('reauthorizes access immediately before mutation', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start();
					yield* resume('Rex', 1);
					h.access.value = false;
					yield* resume(label, 2);
				}),
				h.layer,
			),
		);
		expect(h.deletes).toBe(0);
		expect(h.replies).toContain('Este pet não está mais disponível para você.');
	});

	it('deletes in transaction and emits success afterCommit', async () => {
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
		expect(h.entries).toEqual([]);
		expect(h.replies).toContain('Ração deletada com sucesso!');
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
					}),
				),
				h.layer,
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(h.entries).toEqual([entry]);
		expect(h.deletes).toBe(0);
	});

	it('does not roll committed deletion back when afterCommit output fails', async () => {
		const h = harness();
		h.outputFails.value = true;
		const exit = await run(
			Effect.provide(
				Effect.exit(
					Effect.gen(function* () {
						yield* start();
						yield* resume('Rex', 1);
						yield* resume(label, 2);
					}),
				),
				h.layer,
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(h.entries).toEqual([]);
		expect(h.deletes).toBe(1);
	});
});

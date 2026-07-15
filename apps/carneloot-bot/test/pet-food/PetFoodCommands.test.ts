import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import * as MemoryUpdateDeduplicator from 'tfx/MemoryUpdateDeduplicator';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import * as AddFoodConversation from '../../src/bot/conversations/AddFoodConversation.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import * as PetFoodHandlers from '../../src/bot/PetFoodHandlers.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import {
	IanaTimeZone,
	LocalTime,
} from '../../src/domain/pet-food/FoodDateTime.js';
import {
	FoodEntryId,
	PetFoodSettings,
} from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import {
	PetFoodRepository,
	type PetFoodRepositoryService,
} from '../../src/ports/PetFoodRepository.js';
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
const chatId = Schema.decodeUnknownSync(TelegramChatId)(42);
const petName = Schema.decodeUnknownSync(PetName)('Rex');
const pet = {
	id: petId,
	ownerId,
	name: petName,
	nameKey: 'rex',
	createdAt: 0,
	updatedAt: 0,
};
const current = {
	user: { id: ownerId, createdAt: 0, updatedAt: 0 },
	profile: {
		botId,
		telegramUserId,
		username: null,
		firstName: 'Ana',
		lastName: null,
		privateChatId: chatId,
	},
};
const settings = Schema.decodeUnknownSync(PetFoodSettings)({
	petId,
	dayStart: Schema.decodeUnknownSync(LocalTime)('00:00'),
	timeZone: Schema.decodeUnknownSync(IanaTimeZone)('UTC'),
	reminderDelayMs: null,
	createdAt: 0,
	updatedAt: 0,
});
const replies: Array<string> = [];
const reactions: Array<unknown> = [];
let failReply = false;
const messageContext = {
	message: {} as never,
	chatId: 42,
	messageId: 7,
	messageThreadId: undefined,
	businessConnectionId: undefined,
	reply: (text: string) =>
		Effect.suspend(() =>
			failReply
				? Effect.fail('output')
				: Effect.sync(() => {
						replies.push(text);
						return {} as never;
					}),
		),
	replyToCurrent: () => Effect.succeed({} as never),
	react: (reaction: unknown) =>
		Effect.sync(() => {
			reactions.push(reaction);
			return true;
		}),
	editText: () => Effect.succeed({} as never),
	delete: () => Effect.succeed(true),
	sendChatAction: () => Effect.succeed(true),
} as unknown as MessageContextService;
const sql = Layer.succeed(PgClient.PgClient, {
	withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as never);
const identity = Layer.succeed(UserRepository, {
	registerTelegramProfile: () => Effect.die('unused'),
	findByTelegram: () => Effect.succeed(current),
});
const scheduler = Layer.succeed(ReminderScheduler, {
	replaceForLatest: () => Effect.void,
	cancelForPet: () => Effect.void,
});
const provide = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	food: PetFoodRepositoryService,
	pets = [pet],
) =>
	effect.pipe(
		Effect.provideService(CurrentUser, current),
		Effect.provideService(MessageContext, messageContext),
		Effect.provideService(Telegram, {} as never),
		Effect.provideService(PetRepository, {
			findById: () => Effect.die('unused'),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.succeed(pets),
		}),
		Effect.provideService(PetFoodRepository, food),
		Effect.provide(identity),
		Effect.provide(scheduler),
		Effect.provide(sql),
	) as Effect.Effect<A, E>;
const repository = (
	summary: { totalMg: number; latestFedAt: number | null },
	configured = true,
): PetFoodRepositoryService => ({
	lockOwnedPet: () => Effect.succeed(pet),
	getSettings: () => Effect.succeed(configured ? settings : undefined),
	setDayStart: () => Effect.die('unused'),
	setReminderDelay: () => Effect.die('unused'),
	clearReminderDelay: () => Effect.die('unused'),
	latestEntry: () => Effect.succeed(undefined),
	findBySource: () => Effect.succeed(undefined),
	findBusinessDuplicate: () => Effect.succeed(undefined),
	insert: () => Effect.die('unused'),
	status: () => Effect.succeed(summary),
});

describe('pet food command handlers', () => {
	it('renders no pets, missing setup, zero, and configured status exactly', async () => {
		const now = Date.parse('2024-01-02T12:00:00Z');
		const run = async (food: PetFoodRepositoryService, pets = [pet]) => {
			replies.length = 0;
			await Effect.runPromise(
				Effect.provide(
					Effect.andThen(
						TestClock.setTime(now),
						provide(PetFoodHandlers.foodStatus, food, pets),
					),
					TestClock.layer(),
				),
			);
			return replies[0];
		};
		expect(await run(repository({ totalMg: 0, latestFedAt: null }), [])).toBe(
			'Você não tem pets',
		);
		expect(
			await run(repository({ totalMg: 0, latestFedAt: null }, false)),
		).toBe('Você não configurou o início do dia para o pet Rex.');
		expect(await run(repository({ totalMg: 0, latestFedAt: null }))).toBe(
			'- Rex: 0 g, nenhuma ração hoje',
		);
		expect(
			await run(
				repository({
					totalMg: 120_000,
					latestFedAt: now - (2 * 60 + 15) * 60_000,
				}),
			),
		).toBe('- Rex: 120 g, última vez há 2 horas e 15 minutos');
	});

	it('selects a configured pet and completes food insertion with reply and reaction', async () => {
		replies.length = 0;
		reactions.length = 0;
		let inserted = 0;
		const entry = {
			id: entryId,
			petId,
			recordedBy: ownerId,
			amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
			fedAt: Date.parse('2024-01-02T12:00:00Z'),
			sourceBotId: botId,
			sourceUpdateId: 10,
			sourceMessageChatId: chatId,
			sourceMessageId: 7,
			createdAt: 0,
			updatedAt: 0,
		};
		const food: PetFoodRepositoryService = {
			...repository({ totalMg: 0, latestFedAt: null }),
			latestEntry: () => Effect.succeed(entry),
			insert: () =>
				Effect.sync(() => {
					inserted++;
					return entry;
				}),
		};
		const state = {
			ownerId,
			botId,
			telegramUserId,
			pets: [{ id: petId, name: petName }],
			updateId: 10,
			messageChatId: chatId,
			messageId: 7,
		};
		const selected = await Effect.runPromise(
			provide(
				AddFoodConversation.built.implementations.pet.onInput(state, 'Rex'),
				food,
			),
		);
		expect(selected).toMatchObject({ _tag: 'To', step: 'amount' });
		if (selected._tag !== 'To') throw new Error('expected amount transition');
		const completed = await Effect.runPromise(
			Effect.provide(
				Effect.andThen(
					TestClock.setTime(entry.fedAt),
					provide(
						AddFoodConversation.built.implementations.amount.onInput(
							selected.state as never,
							'50g',
						),
						food,
					),
				),
				TestClock.layer(),
			),
		);
		expect(completed._tag).toBe('Complete');
		if (completed._tag === 'Complete' && completed.afterCommit !== undefined)
			await Effect.runPromise(provide(completed.afterCommit, food));
		expect(inserted).toBe(1);
		expect(replies).toContain(
			'Foram adicionados 50 g de ração para o pet Rex.',
		);
		expect(reactions).toEqual([[{ type: 'emoji', emoji: '👍' }]]);
	});

	it('deduplicates the final update before mutation and output', async () => {
		replies.length = 0;
		reactions.length = 0;
		let inserts = 0;
		const entry = {
			id: entryId,
			petId,
			recordedBy: ownerId,
			amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
			fedAt: 0,
			sourceBotId: botId,
			sourceUpdateId: 10,
			sourceMessageChatId: chatId,
			sourceMessageId: 7,
			createdAt: 0,
			updatedAt: 0,
		};
		const food: PetFoodRepositoryService = {
			...repository({ totalMg: 0, latestFedAt: null }),
			insert: () =>
				Effect.sync(() => {
					inserts++;
					return entry;
				}),
			latestEntry: () => Effect.succeed(entry),
		};
		const state = {
			ownerId,
			botId,
			telegramUserId,
			pets: [{ id: petId, name: petName }],
			updateId: 10,
			messageChatId: chatId,
			messageId: 7,
			petId,
			petName,
			timeZone: settings.timeZone!,
		};
		const program = Effect.gen(function* () {
			const dedup = yield* UpdateDeduplicator;
			const dispatch = Effect.gen(function* () {
				const claim = yield* dedup.claim(99);
				if (claim._tag !== 'Acquired') return;
				const transition = yield* provide(
					AddFoodConversation.built.implementations.amount.onInput(
						state,
						'50g',
					),
					food,
				);
				if (
					transition._tag === 'Complete' &&
					transition.afterCommit !== undefined
				)
					yield* provide(transition.afterCommit, food);
				yield* dedup.complete(claim.token, DispatchOutcome.handled);
			});
			yield* dispatch;
			yield* dispatch;
		});
		await Effect.runPromise(
			Effect.provide(
				Effect.provide(program, MemoryUpdateDeduplicator.layerMemory),
				TestClock.layer(),
			),
		);
		expect(inserts).toBe(1);
		expect(replies).toEqual([
			'Foram adicionados 50 g de ração para o pet Rex.',
		]);
		expect(reactions).toHaveLength(1);
	});

	it('stays safely when pet setup is missing', async () => {
		replies.length = 0;
		const state = {
			ownerId,
			botId,
			telegramUserId,
			pets: [{ id: petId, name: petName }],
			updateId: 10,
			messageChatId: chatId,
			messageId: 7,
		};
		const food = repository({ totalMg: 0, latestFedAt: null }, false);
		const transition = await Effect.runPromise(
			provide(
				AddFoodConversation.built.implementations.pet.onInput(state, 'Rex'),
				food,
			),
		);
		expect(transition._tag).toBe('Stay');
		if (transition.afterCommit !== undefined)
			await Effect.runPromise(provide(transition.afterCommit, food));
		expect(replies).toEqual([
			'Você não configurou o início do dia para o pet Rex.',
		]);
	});

	it('exits without a conversation when no pets exist', async () => {
		replies.length = 0;
		await Effect.runPromise(
			provide(
				PetFoodHandlers.startAddFood,
				repository({ totalMg: 0, latestFedAt: null }),
				[],
			),
		);
		expect(replies).toEqual(['Você não tem pets']);
	});

	it('re-prompts malformed and duplicate food input without inserting', async () => {
		replies.length = 0;
		let inserts = 0;
		const existing = {
			id: entryId,
			petId,
			recordedBy: ownerId,
			amountMg: Schema.decodeUnknownSync(FoodAmountMg)(1_000),
			fedAt: 0,
			sourceBotId: botId,
			sourceUpdateId: 1,
			sourceMessageChatId: chatId,
			sourceMessageId: 7,
			createdAt: 0,
			updatedAt: 0,
		};
		const food: PetFoodRepositoryService = {
			...repository({ totalMg: 0, latestFedAt: null }),
			findBusinessDuplicate: () => Effect.succeed(existing),
			insert: () =>
				Effect.sync(() => {
					inserts++;
					return existing;
				}),
		};
		const state = {
			ownerId,
			botId,
			telegramUserId,
			pets: [{ id: petId, name: petName }],
			updateId: 10,
			messageChatId: chatId,
			messageId: 7,
			petId,
			petName,
			timeZone: settings.timeZone!,
		};
		for (const value of ['abc', '50g 10:00']) {
			const transition = await Effect.runPromise(
				Effect.provide(
					provide(
						AddFoodConversation.built.implementations.amount.onInput(
							state,
							value,
						),
						food,
					),
					TestClock.layer(),
				),
			);
			expect(transition._tag).toBe('Stay');
		}
		expect(inserts).toBe(0);
	});

	it('renders a localized backdated confirmation and preserves commit on output failure', async () => {
		replies.length = 0;
		let inserts = 0;
		const backdated = {
			id: entryId,
			petId,
			recordedBy: ownerId,
			amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
			fedAt: Date.parse('2024-01-01T10:00:00Z'),
			sourceBotId: botId,
			sourceUpdateId: 10,
			sourceMessageChatId: chatId,
			sourceMessageId: 7,
			createdAt: 0,
			updatedAt: 0,
		};
		const latest = {
			...backdated,
			id: Schema.decodeUnknownSync(FoodEntryId)(
				'00000000-0000-4000-8000-000000000004',
			),
			fedAt: Date.parse('2024-01-02T12:00:00Z'),
		};
		const food: PetFoodRepositoryService = {
			...repository({ totalMg: 0, latestFedAt: null }),
			insert: () =>
				Effect.sync(() => {
					inserts++;
					return backdated;
				}),
			latestEntry: () => Effect.succeed(latest),
		};
		const state = {
			ownerId,
			botId,
			telegramUserId,
			pets: [{ id: petId, name: petName }],
			updateId: 10,
			messageChatId: chatId,
			messageId: 7,
			petId,
			petName,
			timeZone: settings.timeZone!,
		};
		const transition = await Effect.runPromise(
			Effect.provide(
				Effect.andThen(
					TestClock.setTime(Date.parse('2024-01-02T12:00:00Z')),
					provide(
						AddFoodConversation.built.implementations.amount.onInput(
							state,
							'50g 01/01/2024 10:00',
						),
						food,
					),
				),
				TestClock.layer(),
			),
		);
		expect(transition._tag).toBe('Complete');
		if (transition._tag !== 'Complete' || transition.afterCommit === undefined)
			return;
		await Effect.runPromise(provide(transition.afterCommit, food));
		expect(replies).toEqual([
			'Foram adicionados 50 g de ração para o pet Rex. Horário: 01/01/2024 10:00.',
		]);
		failReply = true;
		const output = await Effect.runPromise(
			Effect.result(provide(transition.afterCommit, food)),
		);
		failReply = false;
		expect(output._tag).toBe('Failure');
		expect(inserts).toBe(1);
	});
});

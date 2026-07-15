import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import * as DayStart from '../../src/bot/conversations/ConfigureDayStartConversation.js';
import * as Reminder from '../../src/bot/conversations/ConfigureReminderDelayConversation.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import * as PetFoodHandlers from '../../src/bot/PetFoodHandlers.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
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
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const petName = Schema.decodeUnknownSync(PetName)('Rex');
const base = {
	ownerId,
	botId,
	telegramUserId,
	pets: [{ id: petId, name: petName }],
};
const noop = Effect.die('unused');
const foodRepository = Layer.succeed(PetFoodRepository, {
	lockOwnedPet: () => noop,
	getSettings: () => Effect.succeed(undefined),
	setDayStart: () => noop,
	setReminderDelay: () => noop,
	clearReminderDelay: () => noop,
	latestEntry: () => Effect.succeed(undefined),
	findBySource: () => Effect.succeed(undefined),
	findBusinessDuplicate: () => Effect.succeed(undefined),
	insert: () => noop,
	status: () => noop,
} as unknown as PetFoodRepositoryService);
const dependencies = Layer.mergeAll(
	foodRepository,
	Layer.succeed(UserRepository, {
		registerTelegramProfile: () => noop,
		findByTelegram: () => noop,
	}),
	Layer.succeed(ReminderScheduler, {
		replaceForLatest: () => Effect.void,
		cancelForPet: () => Effect.void,
	}),
	Layer.succeed(PgClient.PgClient, {
		withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	} as never),
);
const replies: Array<string> = [];
const messageContext = {
	message: {} as never,
	chatId: 1,
	messageId: 1,
	messageThreadId: undefined,
	businessConnectionId: undefined,
	reply: (text: string) =>
		Effect.sync(() => {
			replies.push(text);
			return {} as never;
		}),
	replyToCurrent: () => Effect.succeed({} as never),
	react: () => Effect.succeed(true),
	editText: () => Effect.succeed({} as never),
	delete: () => Effect.succeed(true),
	sendChatAction: () => Effect.succeed(true),
} as unknown as MessageContextService;

describe('pet food conversations', () => {
	it('accepts midnight and rejects forged pet choices', async () => {
		const midnight = DayStart.built.implementations.hour.onInput(
			{ ...base, petId },
			'0h',
		);
		const forged = DayStart.built.implementations.pet.onInput(base, 'Outro');
		const [hour, invalid] = await Effect.runPromise(
			Effect.provide(
				Effect.provideService(
					Effect.provideService(
						Effect.all([midnight, forged]),
						MessageContext,
						messageContext,
					),
					Telegram,
					{} as never,
				),
				dependencies,
			),
		);
		expect(hour).toMatchObject({
			_tag: 'To',
			step: 'timezone',
			state: { dayStart: '00:00' },
		});
		expect(invalid._tag).toBe('Stay');
	});
	it.each([
		['30 minutos', 1_800_000],
		['2 horas', 7_200_000],
		['30 minutes', 1_800_000],
		['2 hours', 7_200_000],
	])('parses %s', async (text, expected) => {
		expect(await Effect.runPromise(Reminder.parseDuration(text))).toBe(
			expected,
		);
	});
	it('rejects invalid durations', async () => {
		for (const value of ['0 minutos', '-1 hour', '31 dias'])
			expect(
				(await Effect.runPromise(Effect.result(Reminder.parseDuration(value))))
					._tag,
			).toBe('Failure');
	});
	it('does not create a conversation when owner has no pets', async () => {
		replies.length = 0;
		const current = {
			user: { id: ownerId, createdAt: 0, updatedAt: 0 },
			profile: {
				botId,
				telegramUserId,
				username: null,
				firstName: 'Ana',
				lastName: null,
				privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
			},
		};
		const program = PetFoodHandlers.startConfigureDayStart.pipe(
			Effect.provideService(CurrentUser, current),
			Effect.provideService(PetRepository, {
				addOwned: () => noop,
				listOwned: () => Effect.succeed([]),
			}),
			Effect.provideService(MessageContext, messageContext),
		);
		await Effect.runPromise(program as Effect.Effect<void, unknown>);
		expect(replies).toEqual(['Você não tem pets']);
	});
});

import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { UpdateContext } from 'tfx/UpdateContext';
import { describe, expect, it } from 'vitest';

import * as CancelConversation from '../../src/bot/CancelConversation.js';
import * as AddFood from '../../src/bot/conversations/AddFoodConversation.js';
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
import {
	FoodEntryId,
	type PetFoodEntry,
	type PetFoodSettings,
} from '../../src/domain/pet-food/PetFood.js';
import { PetAccessDenied } from '../../src/domain/pet-food/PetFoodError.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import {
	PetFoodRepository,
	type PetFoodRepositoryService,
} from '../../src/ports/PetFoodRepository.js';
import {
	PetRepository,
	type PetRepositoryService,
} from '../../src/ports/PetRepository.js';
import {
	ReminderScheduler,
	type ReminderSchedulerService,
} from '../../src/ports/ReminderScheduler.js';
import {
	UserRepository,
	type UserRepositoryService,
} from '../../src/ports/UserRepository.js';

const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000002',
);
const foodEntryId = Schema.decodeUnknownSync(FoodEntryId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const privateChatId = Schema.decodeUnknownSync(TelegramChatId)(42);
const petName = Schema.decodeUnknownSync(PetName)('Rex');
const pet = {
	id: petId,
	ownerId,
	name: petName,
	nameKey: 'rex',
	createdAt: DateTime.makeUnsafe(0),
	updatedAt: DateTime.makeUnsafe(0),
};
const current = {
	user: {
		id: ownerId,
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	},
	profile: {
		botId,
		telegramUserId,
		username: null,
		firstName: 'Ana',
		lastName: null,
		privateChatId,
	},
};
const scope = { botId: 'carneloot', chatId: 10, userId: 42 };
const update = {
	update: { update_id: 1 } as never,
	updateId: 1,
	chatId: scope.chatId,
	userId: scope.userId,
};
const startup = {
	actorId: ownerId,
	botId,
	telegramUserId,
	pets: [{ id: petId, name: petName }],
};

interface Harness {
	replies: Array<string>;
	settings: { value: PetFoodSettings | undefined };
	settingsReads: { value: number };
	dayMutations: Array<readonly [string, string]>;
	delayMutations: Array<Duration.Duration>;
	scheduler: Array<string>;
	authorizationFails: { value: boolean };
	outputFailure: { value: boolean };
	removeKeyboardReplies: Array<boolean>;
	layer: Layer.Layer<
		| ConversationStorage
		| PetFoodRepository
		| UserRepository
		| PetRepository
		| ReminderScheduler
		| PgClient.PgClient
		| MessageContext
		| Telegram
		| CurrentUser
		| UpdateContext
	>;
	context: MessageContextService;
}
const harness = (): Harness => {
	const replies: Array<string> = [];
	const settings: Harness['settings'] = { value: undefined };
	const settingsReads = { value: 0 };
	const dayMutations: Array<readonly [string, string]> = [];
	const delayMutations: Array<Duration.Duration> = [];
	const scheduler: Array<string> = [];
	const authorizationFails = { value: false };
	const outputFailure = { value: false };
	const removeKeyboardReplies: Array<boolean> = [];
	const context = {
		message: {} as never,
		chatId: scope.chatId,
		messageId: 1,
		messageThreadId: undefined,
		businessConnectionId: undefined,
		reply: (text: string, options) =>
			Effect.suspend(() => {
				removeKeyboardReplies.push(
					(
						options?.reply_markup as
							| { readonly remove_keyboard?: boolean }
							| undefined
					)?.remove_keyboard === true,
				);
				if (
					outputFailure.value &&
					(text.includes('sucesso') || text.includes('configurado para'))
				)
					return Effect.die(new Error('output failed'));
				replies.push(text);
				return Effect.succeed({} as never);
			}),
		replyToCurrent: () => Effect.succeed({} as never),
		react: () => Effect.succeed(true),
		editText: () => Effect.succeed({} as never),
		delete: () => Effect.succeed(true),
		sendChatAction: () => Effect.succeed(true),
	} satisfies MessageContextService;
	const food: PetFoodRepositoryService = {
		lockOwnedPet: () =>
			authorizationFails.value
				? Effect.fail(new PetAccessDenied({ message: 'denied' }))
				: Effect.succeed(pet),
		getSettings: () =>
			Effect.sync(() => {
				settingsReads.value++;
				return settings.value;
			}),
		setDayStart: (_id, dayStart, timeZone, now) =>
			Effect.sync(() => {
				dayMutations.push([dayStart, timeZone]);
				settings.value = {
					petId,
					dayStart,
					timeZone,
					reminderDelay: settings.value?.reminderDelay ?? null,
					createdAt: settings.value?.createdAt ?? now,
					updatedAt: now,
				};
				return settings.value;
			}),
		setReminderDelay: (_id, delay, now) =>
			Effect.sync(() => {
				delayMutations.push(delay);
				settings.value = {
					petId,
					dayStart: settings.value?.dayStart ?? null,
					timeZone: settings.value?.timeZone ?? null,
					reminderDelay: delay,
					createdAt: settings.value?.createdAt ?? now,
					updatedAt: now,
				};
				return settings.value;
			}),
		clearReminderDelay: (_id, now) =>
			Effect.sync(() => {
				settings.value = {
					petId,
					dayStart: settings.value?.dayStart ?? null,
					timeZone: settings.value?.timeZone ?? null,
					reminderDelay: null,
					createdAt: settings.value?.createdAt ?? now,
					updatedAt: now,
				};
				return settings.value;
			}),
		latestEntry: () =>
			Effect.succeed({
				id: foodEntryId,
				petId,
				recordedBy: ownerId,
				amountMg: 1000 as never,
				fedAt: DateTime.makeUnsafe(1000),
				sourceBotId: botId,
				sourceUpdateId: 1,
				sourceMessageChatId: null,
				sourceMessageId: null,
				createdAt: DateTime.makeUnsafe(1000),
				updatedAt: DateTime.makeUnsafe(1000),
			} satisfies PetFoodEntry),
		findBySource: () => Effect.succeed(undefined),
		findBusinessDuplicate: () => Effect.succeed(undefined),
		insert: () => Effect.die('unused'),
		status: () => Effect.die('unused'),
	};
	const users: UserRepositoryService = {
		registerTelegramProfile: () => Effect.die('unused'),
		findById: () => Effect.die('unused'),
		findByUsername: () => Effect.die('unused'),
		findByTelegram: () => Effect.succeed(current),
	};
	const pets: PetRepositoryService = {
		findById: () => Effect.die('unused'),
		lockById: () =>
			authorizationFails.value
				? Effect.succeed(undefined)
				: Effect.succeed(pet),
		deleteOwned: () => Effect.die('unused'),
		addOwned: () => Effect.die('unused'),
		listOwned: () => Effect.succeed([pet]),
		listAccessible: () => Effect.succeed([pet]),
	};
	const reminders: ReminderSchedulerService = {
		replaceForLatest: (value) =>
			Effect.sync(() =>
				scheduler.push(`replace:${DateTime.toEpochMillis(value.runAt)}`),
			).pipe(Effect.asVoid),
		cancelForPet: () =>
			Effect.sync(() => scheduler.push('cancel')).pipe(Effect.asVoid),
	};
	const client = {
		withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	};
	const layer = Layer.mergeAll(
		MemoryConversationStorage.layer,
		Layer.succeed(PetFoodRepository, food),
		Layer.succeed(UserRepository, users),
		Layer.succeed(PetRepository, pets),
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
		Layer.succeed(ReminderScheduler, reminders),
		Layer.succeed(PgClient.PgClient, client as unknown as PgClient.PgClient),
		Layer.succeed(MessageContext, context),
		Layer.succeed(Telegram, {} as never),
		Layer.succeed(CurrentUser, current),
		Layer.succeed(UpdateContext, update),
	);
	return {
		replies,
		settings,
		settingsReads,
		dayMutations,
		delayMutations,
		scheduler,
		authorizationFails,
		outputFailure,
		removeKeyboardReplies,
		layer,
		context,
	};
};
const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
	Effect.runPromise(effect as Effect.Effect<A, E>);
const withFreshConversations = <A, E, R>(
	effect: Effect.Effect<A, E, R | Conversations>,
) => Effect.provide(effect, Layer.fresh(ConversationsLive.layer));
const resume = (
	built: typeof DayStart.built | typeof Reminder.built | typeof AddFood.built,
	input: string,
	updateId: number,
) =>
	withFreshConversations(
		Effect.flatMap(Conversations, (service) =>
			service.resume(built, input, { scope, updateId }),
		),
	);
const start = (built: typeof DayStart.built | typeof Reminder.built) =>
	withFreshConversations(
		Effect.flatMap(Conversations, (service) =>
			service.start(built, startup, { scope, conflict: 'replace' }),
		),
	);

const dayPrefix = Effect.gen(function* () {
	yield* start(DayStart.built);
	yield* resume(DayStart.built, 'Rex', 1);
	yield* resume(DayStart.built, 'Alterar', 2);
	yield* resume(DayStart.built, '0h', 3);
});
const reminderPrefix = (action: 'Definir' | 'Alterar' | 'Excluir') =>
	Effect.gen(function* () {
		yield* start(Reminder.built);
		yield* resume(Reminder.built, 'Rex', 1);
		yield* resume(Reminder.built, action, 2);
	});

describe('pet food conversation transcripts', () => {
	it('uses a tagged invalid reminder duration error', async () => {
		const result = await Effect.runPromise(
			Effect.result(Reminder.parseDuration('invalid')),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'InvalidReminderDurationError' },
		});
	});
	it('completes midnight day-start after a service rebuild', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* dayPrefix;
					yield* resume(DayStart.built, 'UTC', 4);
					const storage = yield* ConversationStorage;
					expect(yield* storage.load(scope)).toBeUndefined();
				}),
				h.layer,
			),
		);
		expect(h.dayMutations).toEqual([['00:00', 'UTC']]);
		expect(h.replies).toEqual([
			'Escolha o pet: Rex',
			'Início do dia não configurado. Envie Alterar.',
			'Escolha a hora de 0h a 23h.',
			'Envie o fuso horário, por exemplo America/Sao_Paulo.',
			'Início do dia configurado com sucesso!',
		]);
	});

	it('stays on forged pet and invalid timezone; authorization failure does not mutate', async () => {
		const forged = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(DayStart.built);
					yield* resume(DayStart.built, 'Outro', 1);
				}),
				forged.layer,
			),
		);
		expect(forged.replies.slice(-2)).toEqual([
			'Por favor, escolha uma opção',
			'Escolha o pet: Rex',
		]);

		const invalid = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* dayPrefix;
					yield* resume(DayStart.built, 'Invalid/Zone', 4);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('timezone');
				}),
				invalid.layer,
			),
		);
		expect(invalid.dayMutations).toHaveLength(0);

		const denied = harness();
		denied.authorizationFails.value = true;
		const result = await run(
			Effect.provide(
				Effect.result(
					Effect.gen(function* () {
						yield* dayPrefix;
						return yield* resume(DayStart.built, 'UTC', 4);
					}),
				),
				denied.layer,
			),
		);
		expect(result._tag).toBe('Failure');
		expect(denied.dayMutations).toHaveLength(0);
	});

	it.each([
		['2 horas', 7_200_000],
		['30 minutes', 1_800_000],
	] as const)(
		'defines reminder from %s after restart',
		async (text, milliseconds) => {
			const h = harness();
			await run(
				Effect.provide(
					Effect.gen(function* () {
						yield* reminderPrefix('Definir');
						yield* resume(Reminder.built, text, 3);
					}),
					h.layer,
				),
			);
			expect(h.delayMutations.map(Duration.toMillis)).toEqual([milliseconds]);
			expect(h.scheduler).toEqual([`replace:${1000 + milliseconds}`]);
			expect(h.replies.at(-1)).toContain(
				milliseconds === 7_200_000 ? '2 horas' : '30 minutos',
			);
		},
	);

	it('changes and deletes existing reminder with exact scheduler calls', async () => {
		const changed = harness();
		changed.settings.value = {
			petId,
			dayStart: null,
			timeZone: null,
			reminderDelay: Duration.minutes(1),
			createdAt: DateTime.makeUnsafe(0),
			updatedAt: DateTime.makeUnsafe(0),
		};
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* reminderPrefix('Alterar');
					yield* resume(Reminder.built, '30 minutos', 3);
				}),
				changed.layer,
			),
		);
		expect(changed.scheduler).toEqual([`replace:${1000 + 1_800_000}`]);

		const deleted = harness();
		deleted.settings.value = {
			petId,
			dayStart: null,
			timeZone: null,
			reminderDelay: Duration.minutes(1),
			createdAt: DateTime.makeUnsafe(0),
			updatedAt: DateTime.makeUnsafe(0),
		};
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* reminderPrefix('Excluir');
					yield* resume(Reminder.built, 'Confirmar', 3);
				}),
				deleted.layer,
			),
		);
		expect(deleted.scheduler).toEqual(['cancel']);
		expect(deleted.replies.at(-1)).toBe('Notificações desativadas.');
	});

	it('keeps invalid duration and commits before failed success output without replay', async () => {
		const invalid = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* reminderPrefix('Definir');
					yield* resume(Reminder.built, '0 minutos', 3);
				}),
				invalid.layer,
			),
		);
		expect(invalid.replies).toContain(
			'Formato inválido. Envie uma duração positiva de até 30 dias.',
		);

		const failed = harness();
		failed.outputFailure.value = true;
		const result = await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* reminderPrefix('Definir');
					const exit = yield* Effect.exit(resume(Reminder.built, '2 hours', 3));
					const storage = yield* ConversationStorage;
					expect(yield* storage.load(scope)).toBeUndefined();
					yield* resume(Reminder.built, '2 hours', 3);
					return exit;
				}),
				failed.layer,
			),
		);
		expect(result._tag).toBe('Failure');
		expect(failed.delayMutations.map(Duration.toMillis)).toEqual([7_200_000]);
	});

	it('authorizes every selected pet before reading settings', async () => {
		for (const selection of [
			DayStart.built.implementations.pet.onInput(startup, 'Rex'),
			Reminder.built.implementations.pet.onInput(startup, 'Rex'),
			AddFood.built.implementations.pet.onInput(startup, 'Rex'),
		] as ReadonlyArray<Effect.Effect<unknown, unknown, unknown>>) {
			const h = harness();
			h.authorizationFails.value = true;
			const result = await run(
				Effect.provide(Effect.result(selection), h.layer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'PetAccessDenied' },
			});
			expect(h.settingsReads.value).toBe(0);
		}
	});

	it('resumes AddFood through a fresh service and cancels persisted state', async () => {
		const h = harness();
		h.settings.value = {
			petId,
			dayStart: '00:00' as never,
			timeZone: 'UTC' as never,
			reminderDelay: null,
			createdAt: DateTime.makeUnsafe(0),
			updatedAt: DateTime.makeUnsafe(0),
		};
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* withFreshConversations(PetFoodHandlers.startAddFood);
					yield* resume(AddFood.built, 'Rex', 1);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('amount');
					yield* withFreshConversations(CancelConversation.cancelCurrent);
					expect(yield* storage.load(scope)).toBeUndefined();
				}),
				h.layer,
			),
		);
		expect(h.replies).toContain('Conversa cancelada.');
		expect(h.removeKeyboardReplies.filter(Boolean)).toHaveLength(1);
	});

	it('repeating starts replace state and cancellation removes both flows', async () => {
		const h = harness();
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* withFreshConversations(PetFoodHandlers.startConfigureDayStart);
					yield* resume(DayStart.built, 'Rex', 1);
					yield* withFreshConversations(PetFoodHandlers.startConfigureDayStart);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('pet');
					yield* withFreshConversations(CancelConversation.cancelCurrent);
					expect(yield* storage.load(scope)).toBeUndefined();
					yield* withFreshConversations(
						PetFoodHandlers.startConfigureReminderDelay,
					);
					yield* resume(Reminder.built, 'Rex', 2);
					yield* withFreshConversations(
						PetFoodHandlers.startConfigureReminderDelay,
					);
					expect((yield* storage.load(scope))?.step).toBe('pet');
					yield* withFreshConversations(CancelConversation.cancelCurrent);
					expect(yield* storage.load(scope)).toBeUndefined();
				}),
				h.layer,
			),
		);
		expect(
			h.replies.filter((text) => text === 'Conversa cancelada.'),
		).toHaveLength(2);
		expect(h.removeKeyboardReplies.filter(Boolean)).toHaveLength(2);
	});

	it('does not create state when no pets exist', async () => {
		const h = harness();
		const emptyPets: PetRepositoryService = {
			findById: () => Effect.die('unused'),
			lockById: () => Effect.die('unused'),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.succeed([]),
			listAccessible: () => Effect.succeed([]),
		};
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* withFreshConversations(
						Effect.provideService(
							PetFoodHandlers.startConfigureDayStart,
							PetRepository,
							emptyPets,
						),
					);
					const storage = yield* ConversationStorage;
					expect(yield* storage.load(scope)).toBeUndefined();
				}),
				h.layer,
			),
		);
		expect(h.replies).toContain('Você não tem pets');
	});
});

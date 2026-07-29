import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';
import type { TaggedError } from 'tfx/TaggedError';

import * as ConfigureReminderDelay from '../../application/ConfigureReminderDelay.js';
import { authorize } from '../../application/PetFoodAccess.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { ReminderDelay } from '../../domain/pet-food/PetFood.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption),
};
const PetState = Schema.Struct(Base);
const ReminderDelayMilliseconds = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({
		minimum: 1,
		maximum: Duration.toMillis(Duration.days(30)),
	}),
);
const ActionState = Schema.Struct({
	...Base,
	petId: PetId,
	currentDelayMs: Schema.NullOr(ReminderDelayMilliseconds),
});
const SelectedState = Schema.Struct({ ...Base, petId: PetId });
const Text = ConversationInput.text(Schema.String);
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);
const actionChoice = (currentDelayMs: number | null) =>
	ConversationChoice.reply(
		currentDelayMs === null
			? [{ label: 'Definir', value: 'define' as const }]
			: [
					{ label: 'Alterar', value: 'change' as const },
					{ label: 'Excluir', value: 'delete' as const },
				],
		{ columns: 2, cancelLabel: 'Cancelar' },
	);
const deleteChoice = ConversationChoice.reply(
	[{ label: 'Confirmar', value: true }],
	{ cancelLabel: 'Cancelar' },
);
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) =>
	effect;
const reply = ConversationUi.reply;
const replyRemovingKeyboard = ConversationUi.replyRemovingKeyboard;
const required = <A, E extends TaggedError, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		yield* PgClient.PgClient;
		yield* PetFoodRepository;
		yield* PetRepository;
		yield* PetCaregiverRepository;
		yield* ReminderScheduler;
		yield* UserRepository;
		return yield* effect;
	});
const invalidChoice = required(
	Effect.succeed(
		ConversationBuilder.stay({
			afterCommit: reply('Por favor, escolha uma opção'),
		}),
	),
);
const invalidDuration = required(
	Effect.succeed(
		ConversationBuilder.stay({
			afterCommit: reply(
				'Formato inválido. Envie uma duração positiva de até 30 dias.',
			),
		}),
	),
);

export class InvalidReminderDurationError extends Data.TaggedError(
	'InvalidReminderDurationError',
)<{ readonly message: string }> {}

export const parseDuration = (input: string) => {
	const match =
		/^\s*(\d+(?:[.,]\d+)?)\s*(minuto(?:s)?|minute(?:s)?|hora(?:s)?|hour(?:s)?)\s*$/iu.exec(
			input,
		);
	if (match === null)
		return Effect.fail(
			new InvalidReminderDurationError({ message: 'Invalid duration' }),
		);
	const amount = Number((match[1] ?? '').replace(',', '.'));
	const unit = (match[2] ?? '').toLocaleLowerCase('en-US');
	const milliseconds = amount * (unit.startsWith('h') ? 3_600_000 : 60_000);
	return Schema.decodeUnknownEffect(ReminderDelay)(
		Duration.millis(milliseconds),
	).pipe(
		Effect.mapError(
			() =>
				new InvalidReminderDurationError({ message: 'Invalid duration range' }),
		),
	);
};

const normalized = (duration: Duration.Duration) => {
	const milliseconds = Duration.toMillis(duration);
	if (milliseconds % 3_600_000 === 0) {
		const hours = milliseconds / 3_600_000;
		return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
	}
	const minutes = milliseconds / 60_000;
	return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
};

export const declaration = Conversation.make('configure-reminder-delay', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		action: Conversation.step('action', { state: ActionState, input: Text }),
		duration: Conversation.step('duration', {
			state: SelectedState,
			input: Text,
		}),
		deleteConfirm: Conversation.step('deleteConfirm', {
			state: SelectedState,
			input: ConversationInput.choice(deleteChoice),
		}),
	},
	idleTimeout: '15 minutes',
	error: ApplicationError,
});

const access = (state: typeof SelectedState.Type) => ({
	actorId: state.actorId,
	botId: state.botId,
	telegramUserId: state.telegramUserId,
	petId: state.petId,
});

export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					state.pets.length === 0
						? replyRemovingKeyboard('Você não tem pets')
						: ConversationUi.promptChoice('Escolha o pet:', petChoice(state)),
				),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							if (state.pets.length === 0)
								return ConversationBuilder.cancelled({
									afterCommit: replyRemovingKeyboard('Você não tem pets'),
								});
							const result = yield* Effect.result(
								ConversationPrompt.resolve(petChoice(state), value),
							);
							if (result._tag === 'Failure') return yield* invalidChoice;
							const selected = result.success;
							if (selected._tag === 'Cancelled')
								return ConversationBuilder.cancelled({
									afterCommit: replyRemovingKeyboard('Operação cancelada.'),
								});
							const pet = state.pets.find((item) => item.id === selected.value);
							if (pet === undefined) return yield* invalidChoice;
							yield* authorize({
								actorId: state.actorId,
								botId: state.botId,
								telegramUserId: state.telegramUserId,
								petId: pet.id,
							});
							const repository = yield* PetFoodRepository;
							const settings = yield* repository.getSettings(pet.id);
							const currentDelay = settings?.reminderDelay ?? null;
							return ConversationBuilder.to('action', {
								...state,
								petId: pet.id,
								currentDelayMs:
									currentDelay === null
										? null
										: Duration.toMillis(currentDelay),
							});
						}),
					),
				),
			onInvalid: () => invalidChoice,
		})
		.step('action', {
			enter: (state) =>
				required(
					ConversationUi.promptChoice(
						state.currentDelayMs === null
							? 'Notificações desativadas.'
							: `Atraso atual: ${normalized(Duration.millis(state.currentDelayMs))}.`,
						actionChoice(state.currentDelayMs),
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const resolved = yield* Effect.result(
							ConversationPrompt.resolve(
								actionChoice(state.currentDelayMs),
								value,
							),
						);
						if (resolved._tag === 'Failure') return yield* invalidChoice;
						if (resolved.success._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const action = resolved.success.value;
						const selected = {
							actorId: state.actorId,
							botId: state.botId,
							telegramUserId: state.telegramUserId,
							pets: state.pets,
							petId: state.petId,
						};
						if (action === 'define' && state.currentDelayMs === null)
							return ConversationBuilder.to('duration', selected);
						if (action === 'change' && state.currentDelayMs !== null)
							return ConversationBuilder.to('duration', selected);
						if (action === 'delete' && state.currentDelayMs !== null)
							return ConversationBuilder.to('deleteConfirm', selected);
						return yield* invalidChoice;
					}),
				),
			onInvalid: () => invalidChoice,
		})
		.step('duration', {
			enter: () =>
				required(
					replyRemovingKeyboard(
						'Envie a duração, por exemplo 30 minutos ou 2 horas.',
					),
				),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const result = yield* Effect.result(parseDuration(value));
							if (result._tag === 'Failure') return yield* invalidDuration;
							yield* ConfigureReminderDelay.set(access(state), result.success);
							return ConversationBuilder.complete({
								afterCommit: replyRemovingKeyboard(
									`Atraso de notificação configurado para ${normalized(result.success)}.`,
								),
							});
						}),
					),
				),
			onInvalid: () => invalidDuration,
		})
		.step('deleteConfirm', {
			enter: () =>
				required(
					ConversationUi.promptChoice(
						'Confirma excluir o atraso?',
						deleteChoice,
					),
				),
			onInput: (state, selected) =>
				required(
					selected._tag === 'Cancelled'
						? Effect.succeed(
								ConversationBuilder.cancelled({
									afterCommit: replyRemovingKeyboard('Operação cancelada.'),
								}),
							)
						: !selected.value
							? invalidChoice
							: widen(
									Effect.as(
										ConfigureReminderDelay.remove(access(state)),
										ConversationBuilder.complete({
											afterCommit: replyRemovingKeyboard(
												'Notificações desativadas.',
											),
										}),
									),
								),
				),
			onInvalid: () => invalidChoice,
		}),
);

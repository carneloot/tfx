import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as ConfigureReminderDelay from '../../application/ConfigureReminderDelay.js';
import { authorize } from '../../application/PetFoodAccess.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { ReminderDelayMs } from '../../domain/pet-food/PetFood.js';
import { PetName } from '../../domain/Pet.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	ownerId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption),
};
const PetState = Schema.Struct(Base);
const ActionState = Schema.Struct({
	...Base,
	petId: PetId,
	currentDelayMs: Schema.NullOr(ReminderDelayMs),
});
const SelectedState = Schema.Struct({ ...Base, petId: PetId });
const Text = ConversationInput.text(Schema.String);
const widen = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, R> =>
	effect.pipe(Effect.mapError((error): unknown => error));
const reply = (text: string) =>
	widen(
		Effect.flatMap(MessageContext.MessageContext, (context) =>
			context.reply(text),
		),
	);
const required = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		yield* PgClient.PgClient;
		yield* PetFoodRepository;
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

export const parseDuration = (input: string) => {
	const match =
		/^\s*(\d+(?:[.,]\d+)?)\s*(minuto(?:s)?|minute(?:s)?|hora(?:s)?|hour(?:s)?)\s*$/iu.exec(
			input,
		);
	if (match === null) return Effect.fail(new Error('Invalid duration'));
	const amount = Number(match[1]!.replace(',', '.'));
	const unit = match[2]!.toLocaleLowerCase('en-US');
	const milliseconds = amount * (unit.startsWith('h') ? 3_600_000 : 60_000);
	return Schema.decodeUnknownEffect(ReminderDelayMs)(milliseconds);
};

const normalized = (milliseconds: number) => {
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
			input: Text,
		}),
	},
	idleTimeout: 15 * 60 * 1000,
	error: undefined as unknown,
});

const access = (state: typeof SelectedState.Type) => ({
	ownerId: state.ownerId,
	botId: state.botId,
	telegramUserId: state.telegramUserId,
	petId: state.petId,
});

export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					reply(`Escolha o pet: ${state.pets.map((p) => p.name).join(', ')}`),
				),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const pet = state.pets.find((item) => item.name === value);
							if (pet === undefined) return yield* invalidChoice;
							yield* authorize({
								ownerId: state.ownerId,
								botId: state.botId,
								telegramUserId: state.telegramUserId,
								petId: pet.id,
							});
							const repository = yield* PetFoodRepository;
							const settings = yield* repository.getSettings(pet.id);
							return ConversationBuilder.to('action', {
								...state,
								petId: pet.id,
								currentDelayMs: settings?.reminderDelayMs ?? null,
							});
						}),
					),
				),
			onInvalid: () => invalidChoice,
		})
		.step('action', {
			enter: (state) =>
				required(
					reply(
						state.currentDelayMs === null
							? 'Notificações desativadas. Envie Definir.'
							: `Atraso atual: ${normalized(state.currentDelayMs)}. Envie Alterar ou Excluir.`,
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = {
							ownerId: state.ownerId,
							botId: state.botId,
							telegramUserId: state.telegramUserId,
							pets: state.pets,
							petId: state.petId,
						};
						if (value === 'Definir' && state.currentDelayMs === null)
							return ConversationBuilder.to('duration', selected);
						if (value === 'Alterar' && state.currentDelayMs !== null)
							return ConversationBuilder.to('duration', selected);
						if (value === 'Excluir' && state.currentDelayMs !== null)
							return ConversationBuilder.to('deleteConfirm', selected);
						return yield* invalidChoice;
					}),
				),
			onInvalid: () => invalidChoice,
		})
		.step('duration', {
			enter: () =>
				required(reply('Envie a duração, por exemplo 30 minutos ou 2 horas.')),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const result = yield* Effect.result(parseDuration(value));
							if (result._tag === 'Failure') return yield* invalidDuration;
							yield* ConfigureReminderDelay.set(access(state), result.success);
							return ConversationBuilder.complete({
								afterCommit: reply(
									`Atraso de notificação configurado para ${normalized(result.success)}.`,
								),
							});
						}),
					),
				),
			onInvalid: () => invalidDuration,
		})
		.step('deleteConfirm', {
			enter: () => required(reply('Envie Confirmar para excluir o atraso.')),
			onInput: (state, value) =>
				required(
					value !== 'Confirmar'
						? invalidChoice
						: widen(
								Effect.as(
									ConfigureReminderDelay.remove(access(state)),
									ConversationBuilder.complete({
										afterCommit: reply('Notificações desativadas.'),
									}),
								),
							),
				),
			onInvalid: () => invalidChoice,
		}),
);

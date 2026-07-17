import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Conversation, ConversationBuilder, ConversationChoice, ConversationInput, ConversationPrompt, MessageContext } from 'tfx';
import * as Telegram from 'tfx/Telegram';
import type { TaggedError } from 'tfx/TaggedError';

import * as ListCaregivers from '../../application/ListCaregivers.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const State = Schema.Struct({ actorId: UserId, botId: BotId, telegramUserId: TelegramUserId, pets: Schema.Array(PetOption) });
const Text = ConversationInput.text(Schema.String);
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => effect;
const reply = (text: string, removeKeyboard = false) => widen(Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, removeKeyboard ? { reply_markup: ConversationPrompt.removeReplyKeyboard } : undefined)).pipe(Effect.asVoid));
const required = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () { yield* PgClient.PgClient; yield* PetRepository; yield* PetCaregiverRepository; yield* UserRepository; yield* MessageContext.MessageContext; yield* Telegram.Telegram; return yield* effect; });
const choice = (pets: ReadonlyArray<typeof PetOption.Type>) => ConversationChoice.make(pets.map((pet) => ({ label: pet.name, value: pet.id })));
const prompt = (state: typeof State.Type) => Effect.flatMap(MessageContext.MessageContext, (context) => context.reply('Escolha o pet:', { reply_markup: { keyboard: choice(state.pets).options.map((item) => [{ text: item.label }]), one_time_keyboard: true, resize_keyboard: true } })).pipe(Effect.asVoid);
const stay = required(Effect.succeed(ConversationBuilder.stay({ afterCommit: reply('Por favor, escolha uma opção.') })));

export const declaration = Conversation.make('list-pet-caregivers', { version: 1, startup: State, initialStep: 'pet', initialize: (state) => state, steps: { pet: Conversation.step('pet', { state: State, input: Text }) }, idleTimeout: 15 * 60 * 1000, error: ApplicationError });
export const built = ConversationBuilder.done(ConversationBuilder.make(declaration).step('pet', {
	enter: (state) => required(prompt(state)),
	onInput: (state, value) => required(Effect.gen(function* () { const selected = choice(state.pets).options.find((item) => item.label === value); if (selected === undefined) return yield* stay; const pet = state.pets.find((item) => item.id === selected.value); if (pet === undefined) return yield* stay; const result = yield* Effect.result(ListCaregivers.execute(state, pet.id)); if (result._tag === 'Failure' && result.failure._tag === 'CaregiverAccessLost') return ConversationBuilder.complete({ afterCommit: reply('Este pet não está mais disponível para você.', true) }); if (result._tag === 'Failure') return yield* Effect.fail(result.failure); const text = result.success.length === 0 ? `O pet ${pet.name} não possui cuidadores.` : `Cuidadores de ${pet.name}:\n${result.success.map((item) => `• ${item.displayName} — ${item.statusLabel}`).join('\n')}`; return ConversationBuilder.complete({ afterCommit: reply(text, true) }); })),
	onInvalid: () => stay,
}));

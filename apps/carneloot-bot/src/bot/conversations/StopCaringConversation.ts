import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Conversation, ConversationBuilder, ConversationChoice, ConversationInput, ConversationPrompt, MessageContext } from 'tfx';
import * as Telegram from 'tfx/Telegram';
import type { TaggedError } from 'tfx/TaggedError';

import * as StopCaring from '../../application/StopCaring.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = { actorId: UserId, botId: BotId, telegramUserId: TelegramUserId, pets: Schema.Array(PetOption) };
const PetState = Schema.Struct(Base);
const ConfirmState = Schema.Struct({ ...Base, petId: PetId, petName: PetName });
const Text = ConversationInput.text(Schema.String);
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => effect;
const reply = (text: string, removeKeyboard = false) => widen(Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, removeKeyboard ? { reply_markup: ConversationPrompt.removeReplyKeyboard } : undefined)).pipe(Effect.asVoid));
const required = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () { yield* PgClient.PgClient; yield* PetRepository; yield* PetCaregiverRepository; yield* UserRepository; yield* Telegram.Telegram; return yield* effect; });
const petChoice = (items: ReadonlyArray<typeof PetOption.Type>) => ConversationChoice.make(items.map((item) => ({ label: item.name, value: item.id })));
const confirmChoice = ConversationChoice.make([{ label: 'Sim', value: true }, { label: 'Não', value: false }]);
const prompt = <A>(text: string, choice: ConversationChoice.Choice<A, never>) => Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, { reply_markup: { keyboard: choice.options.map((item) => [{ text: item.label }]), one_time_keyboard: true, resize_keyboard: true } })).pipe(Effect.asVoid);
const stay = () => required(Effect.succeed(ConversationBuilder.stay({ afterCommit: reply('Por favor, escolha uma opção.') })));
const unavailable = () => ConversationBuilder.complete({ afterCommit: reply('Este pet não está mais disponível para você.', true) });
const output = (notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>) => Effect.gen(function* () {
	yield* reply('Você parou de cuidar deste pet.', true);
	const telegram = yield* Telegram.Telegram;
	yield* Effect.forEach(notices, (notice) => telegram.sendMessage({ chat_id: notice.chatId, text: notice.text }), { discard: true });
});

export const declaration = Conversation.make('stop-caring-for-pet', { version: 1, startup: PetState, initialStep: 'pet', initialize: (state) => state, steps: { pet: Conversation.step('pet', { state: PetState, input: Text }), confirm: Conversation.step('confirm', { state: ConfirmState, input: Text }) }, idleTimeout: 15 * 60 * 1000, error: ApplicationError });
export const built = ConversationBuilder.done(ConversationBuilder.make(declaration)
	.step('pet', {
		enter: (state) => required(state.pets.length === 0 ? reply('Você não está cuidando de nenhum pet.', true) : prompt('Escolha o pet:', petChoice(state.pets))),
		onInput: (state, value) => required(Effect.gen(function* () { const selected = yield* Effect.result(ConversationPrompt.resolve(petChoice(state.pets), value)); if (selected._tag === 'Failure') return yield* stay(); const resolved = selected.success; if (resolved._tag === 'Cancelled') return yield* stay(); const pet = state.pets.find((item) => item.id === resolved.value); if (pet === undefined) return yield* stay(); return ConversationBuilder.to('confirm', { ...state, petId: pet.id, petName: pet.name }); })),
		onInvalid: () => stay(),
	})
	.step('confirm', {
		enter: (state) => required(prompt(`Deseja parar de cuidar de ${state.petName}?`, confirmChoice)),
		onInput: (state, value) => required(Effect.gen(function* () { const selected = yield* Effect.result(ConversationPrompt.resolve(confirmChoice, value)); if (selected._tag === 'Failure' || selected.success._tag === 'Cancelled') return yield* stay(); if (!selected.success.value) return ConversationBuilder.complete({ afterCommit: reply('Você continuará cuidando deste pet.', true) }); const result = yield* Effect.result(StopCaring.execute(state, state.petId)); if (result._tag === 'Failure' && (result.failure._tag === 'CaregiverAccessLost' || result.failure._tag === 'CaregiverInvitationNotFound' || result.failure._tag === 'CaregiverInvitationNotPending')) return unavailable(); if (result._tag === 'Failure') return yield* Effect.fail(result.failure); return ConversationBuilder.complete({ afterCommit: output(result.success.notices) }); })),
		onInvalid: () => stay(),
	}));

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Conversation, ConversationBuilder, ConversationChoice, ConversationInput, ConversationPrompt, MessageContext, Telegram } from 'tfx';
import type { TaggedError } from 'tfx/TaggedError';

import * as InviteCaregiver from '../../application/InviteCaregiver.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = { actorId: UserId, botId: BotId, telegramUserId: TelegramUserId, pets: Schema.Array(PetOption) };
const PetState = Schema.Struct(Base);
const UsernameState = Schema.Struct({ ...Base, petId: PetId, petName: PetName });
const Text = ConversationInput.text(Schema.String);
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => effect;
const reply = (text: string, removeKeyboard = false) => widen(Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, removeKeyboard ? { reply_markup: ConversationPrompt.removeReplyKeyboard } : undefined)).pipe(Effect.asVoid));
const required = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () { yield* PgClient.PgClient; yield* PetRepository; yield* PetCaregiverRepository; yield* UserRepository; yield* Telegram.Telegram; return yield* effect; });
const choice = (pets: ReadonlyArray<typeof PetOption.Type>) => ConversationChoice.make(pets.map((pet) => ({ label: pet.name, value: pet.id })));
const prompt = (state: typeof PetState.Type) => Effect.flatMap(MessageContext.MessageContext, (context) => context.reply('Escolha o pet:', { reply_markup: { keyboard: choice(state.pets).options.map((item) => [{ text: item.label }]), one_time_keyboard: true, resize_keyboard: true } })).pipe(Effect.asVoid);
const invalid = (text = 'Por favor, escolha uma opção') => required(Effect.succeed(ConversationBuilder.stay({ afterCommit: reply(text) })));
const output = (notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>) => Effect.gen(function* () { yield* reply('Convite enviado com sucesso!', true); const telegram = yield* Telegram.Telegram; yield* Effect.forEach(notices, (notice) => telegram.sendMessage({ chat_id: notice.chatId, text: notice.text }), { discard: true }); });
const unavailable = () => ConversationBuilder.complete({ afterCommit: reply('Este pet não está mais disponível para você.', true) });

export const declaration = Conversation.make('invite-pet-caregiver', { version: 1, startup: PetState, initialStep: 'pet', initialize: (state) => state, steps: { pet: Conversation.step('pet', { state: PetState, input: Text }), username: Conversation.step('username', { state: UsernameState, input: Text }) }, idleTimeout: 15 * 60 * 1000, error: ApplicationError });
export const built = ConversationBuilder.done(ConversationBuilder.make(declaration)
	.step('pet', {
		enter: (state) => required(prompt(state)),
		onInput: (state, value) => required(Effect.gen(function* () { const selected = choice(state.pets).options.find((item) => item.label === value); if (selected === undefined) return yield* invalid(); const pet = state.pets.find((item) => item.id === selected.value); if (pet === undefined) return yield* invalid(); return ConversationBuilder.to('username', { ...state, petId: pet.id, petName: pet.name }); })),
		onInvalid: () => invalid(),
	})
	.step('username', {
		enter: () => required(reply('Envie o @username da pessoa cuidadora.')),
		onInput: (state, value) => required(Effect.gen(function* () { const result = yield* Effect.result(InviteCaregiver.execute(state, state.petId, value)); if (result._tag === 'Failure') { const tag = result.failure._tag; if (tag === 'CaregiverUsernameNotFound') return yield* invalid('Usuário não encontrado. Tente novamente.'); if (tag === 'CaregiverUsernameAmbiguous') return yield* invalid('Mais de um usuário corresponde a esse nome.'); if (tag === 'CaregiverSelfInvitation') return yield* invalid('Você não pode convidar a si mesmo.'); if (tag === 'CaregiverRelationshipExists') return yield* invalid('Esta pessoa já possui um vínculo com este pet.'); if (tag === 'CaregiverAccessLost') return unavailable(); return yield* Effect.fail(result.failure); } return ConversationBuilder.complete({ afterCommit: output(result.success.notices) }); })),
		onInvalid: () => invalid('Envie um username válido.'),
	}));

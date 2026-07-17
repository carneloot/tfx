import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Conversation, ConversationBuilder, ConversationChoice, ConversationInput, ConversationPrompt, MessageContext } from 'tfx';
import * as Telegram from 'tfx/Telegram';
import type { TaggedError } from 'tfx/TaggedError';

import * as RespondPetInvitation from '../../application/RespondPetInvitation.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';

const InvitationOption = Schema.Struct({ petId: PetId, petName: PetName, ownerDisplayName: Schema.String });
const Base = { actorId: UserId, botId: BotId, telegramUserId: TelegramUserId, invitations: Schema.Array(InvitationOption) };
const InvitationState = Schema.Struct(Base);
const ConfirmState = Schema.Struct({ ...Base, petId: PetId, petName: PetName });
const Text = ConversationInput.text(Schema.String);
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => effect;
const reply = (text: string, removeKeyboard = false) => widen(Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, removeKeyboard ? { reply_markup: ConversationPrompt.removeReplyKeyboard } : undefined)).pipe(Effect.asVoid));
const required = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () { yield* PgClient.PgClient; yield* PetRepository; yield* PetCaregiverRepository; yield* UserRepository; yield* Telegram.Telegram; return yield* effect; });
const invitationChoice = (items: ReadonlyArray<typeof InvitationOption.Type>) => ConversationChoice.make(items.map((item) => ({ label: `${item.petName} (${item.ownerDisplayName})`, value: item.petId })));
const confirmChoice = ConversationChoice.make([{ label: 'Sim', value: 'accepted' as const }, { label: 'Não', value: 'rejected' as const }]);
const prompt = <A>(text: string, choice: ConversationChoice.Choice<A, never>) => Effect.flatMap(MessageContext.MessageContext, (context) => context.reply(text, { reply_markup: { keyboard: choice.options.map((item) => [{ text: item.label }]), one_time_keyboard: true, resize_keyboard: true } })).pipe(Effect.asVoid);
const stay = () => required(Effect.succeed(ConversationBuilder.stay({ afterCommit: reply('Por favor, escolha uma opção.') })));
const unavailable = () => ConversationBuilder.complete({ afterCommit: reply('Este convite não está mais disponível.', true) });
const output = (response: 'accepted' | 'rejected', petName: string, notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>) => Effect.gen(function* () {
	yield* reply(response === 'accepted' ? `Convite aceito! Você agora cuida de ${petName}.` : 'Convite recusado.', true);
	const telegram = yield* Telegram.Telegram;
	yield* Effect.forEach(notices, (notice) => telegram.sendMessage({ chat_id: notice.chatId, text: notice.text }), { discard: true });
});

export const declaration = Conversation.make('pet-caregiver-invitations', { version: 1, startup: InvitationState, initialStep: 'invitation', initialize: (state) => state, steps: { invitation: Conversation.step('invitation', { state: InvitationState, input: Text }), confirm: Conversation.step('confirm', { state: ConfirmState, input: Text }) }, idleTimeout: 15 * 60 * 1000, error: ApplicationError });
export const built = ConversationBuilder.done(ConversationBuilder.make(declaration)
	.step('invitation', {
		enter: (state) => required(state.invitations.length === 0 ? reply('Você não tem convites pendentes.', true) : prompt('Escolha um convite:', invitationChoice(state.invitations))),
		onInput: (state, value) => required(Effect.gen(function* () { const selected = yield* Effect.result(ConversationPrompt.resolve(invitationChoice(state.invitations), value)); if (selected._tag === 'Failure') return yield* stay(); const resolved = selected.success; if (resolved._tag === 'Cancelled') return yield* stay(); const invitation = state.invitations.find((item) => item.petId === resolved.value); if (invitation === undefined) return yield* stay(); return ConversationBuilder.to('confirm', { ...state, petId: invitation.petId, petName: invitation.petName }); })),
		onInvalid: () => stay(),
	})
	.step('confirm', {
		enter: (state) => required(prompt(`Deseja aceitar o convite para cuidar de ${state.petName}?`, confirmChoice)),
		onInput: (state, value) => required(Effect.gen(function* () { const selected = yield* Effect.result(ConversationPrompt.resolve(confirmChoice, value)); if (selected._tag === 'Failure' || selected.success._tag === 'Cancelled') return yield* stay(); const response = selected.success.value; const result = yield* Effect.result(RespondPetInvitation.execute(state, state.petId, response)); if (result._tag === 'Failure' && (result.failure._tag === 'CaregiverAccessLost' || result.failure._tag === 'CaregiverInvitationNotFound' || result.failure._tag === 'CaregiverInvitationNotPending')) return unavailable(); if (result._tag === 'Failure') return yield* Effect.fail(result.failure); return ConversationBuilder.complete({ afterCommit: output(response, state.petName, result.success.notices) }); })),
		onInvalid: () => stay(),
	}));

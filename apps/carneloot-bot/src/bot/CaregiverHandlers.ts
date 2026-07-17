import * as Effect from 'effect/Effect';
import { Conversations, MessageContext, UpdateContext } from 'tfx';

import * as ListPetInvitations from '../application/ListPetInvitations.js';
import * as ListPets from '../application/ListPets.js';
import { ConversationOperationError } from '../domain/ApplicationError.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import * as DeletePetConversation from './conversations/DeletePetConversation.js';
import * as InviteCaregiverConversation from './conversations/InviteCaregiverConversation.js';
import * as ListCaregiversConversation from './conversations/ListCaregiversConversation.js';
import * as PetInvitationsConversation from './conversations/PetInvitationsConversation.js';
import * as RemoveCaregiverConversation from './conversations/RemoveCaregiverConversation.js';
import * as StopCaringConversation from './conversations/StopCaringConversation.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

const actor = (current: typeof CurrentUser.Service) => ({
	actorId: current.user.id,
	botId: current.profile.botId,
	telegramUserId: current.profile.telegramUserId,
});

const start = <A, E, R>(built: Parameters<typeof Conversations.Conversations.Service['start']>[0], input: A) =>
	Effect.gen(function* () {
		const update = yield* UpdateContext.UpdateContext;
		if (update.chatId === undefined || update.userId === undefined)
			return yield* Effect.fail(new ConversationOperationError({ message: 'Missing conversation scope', cause: { _tag: 'MissingConversationScope' } }));
		const conversations = yield* Conversations.Conversations;
		yield* conversations.start(built as never, input as never, {
			scope: { botId, chatId: update.chatId, userId: update.userId },
			conflict: 'replace',
		}).pipe(Effect.mapError((cause) => new ConversationOperationError({ message: 'Could not start caregiver conversation', cause })));
	});

const owned = (built: Parameters<typeof Conversations.Conversations.Service['start']>[0]) => Effect.gen(function* () {
	const current = yield* CurrentUser;
	const pets = yield* ListPets.execute(current.user.id);
	if (pets.length === 0) {
		yield* (yield* MessageContext.MessageContext).reply('Você não tem pets');
		return;
	}
	yield* start(built, { ...actor(current), pets: pets.map(({ id, name }) => ({ id, name })) });
});

export const startDeletePet = owned(DeletePetConversation.built);
export const startInviteCaregiver = owned(InviteCaregiverConversation.built);
export const startRemoveCaregiver = owned(RemoveCaregiverConversation.built);
export const startListCaregivers = owned(ListCaregiversConversation.built);

export const startPetInvitations = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const invitations = yield* ListPetInvitations.execute(actor(current));
	if (invitations.length === 0) {
		yield* (yield* MessageContext.MessageContext).reply('Você não tem convites pendentes.');
		return;
	}
	yield* start(PetInvitationsConversation.built, {
		...actor(current),
		invitations: invitations.map(({ pet, ownerDisplayName }) => ({ petId: pet.id, petName: pet.name, ownerDisplayName })),
	});
});

export const startStopCaring = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const caregivers = yield* PetCaregiverRepository;
	const pets = yield* PetRepository;
	const relations = yield* caregivers.listAcceptedForUser(current.user.id);
	const caredPets = (yield* Effect.forEach(relations, (relation) => pets.findById(relation.petId))).filter((pet) => pet !== undefined);
	if (caredPets.length === 0) {
		yield* (yield* MessageContext.MessageContext).reply('Você não está cuidando de nenhum pet.');
		return;
	}
	yield* start(StopCaringConversation.built, { ...actor(current), pets: caredPets.map(({ id, name }) => ({ id, name })) });
});

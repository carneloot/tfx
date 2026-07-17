import * as Effect from 'effect/Effect';
import {
	Conversation,
	Conversations,
	MessageContext,
	UpdateContext,
} from 'tfx';

import * as ListPetInvitations from '../application/ListPetInvitations.js';
import * as ListPets from '../application/ListPets.js';
import { ConversationOperationError } from '../domain/ApplicationError.js';
import type { PetId } from '../domain/Ids.js';
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

const start = <B extends Conversations.BuiltConversation<any, any>>(
	built: B,
	input: Conversation.StartupOf<B['declaration']>,
) =>
	Effect.gen(function* () {
		const update = yield* UpdateContext.UpdateContext;
		if (update.chatId === undefined || update.userId === undefined)
			return yield* Effect.fail(
				new ConversationOperationError({
					message: 'Missing conversation scope',
					cause: { _tag: 'MissingConversationScope' },
				}),
			);
		const conversations = yield* Conversations.Conversations;
		yield* conversations
			.start(built, input, {
				scope: { botId, chatId: update.chatId, userId: update.userId },
				conflict: 'replace',
			})
			.pipe(
				Effect.mapError(
					(cause) =>
						new ConversationOperationError({
							message: 'Could not start caregiver conversation',
							cause,
						}),
				),
			);
	});

const owned = <B extends Conversations.BuiltConversation<any, any>>(
	built: B,
	startup: (
		current: typeof CurrentUser.Service,
		pets: [
			{ readonly id: PetId; readonly name: string },
			...Array<{ readonly id: PetId; readonly name: string }>,
		],
	) => Conversation.StartupOf<B['declaration']>,
) =>
	Effect.gen(function* () {
		const current = yield* CurrentUser;
		const pets = yield* ListPets.execute(current.user.id);
		const first = pets[0];
		if (first === undefined) {
			yield* (yield* MessageContext.MessageContext).reply('Você não tem pets');
			return;
		}
		const options: [
			{ readonly id: PetId; readonly name: string },
			...Array<{ readonly id: PetId; readonly name: string }>,
		] = [
			{ id: first.id, name: first.name },
			...pets.slice(1).map(({ id, name }) => ({ id, name })),
		];
		yield* start(built, startup(current, options));
	});

const ownedStartup = (
	current: typeof CurrentUser.Service,
	pets: Parameters<Parameters<typeof owned>[1]>[1],
) => ({ ...actor(current), pets });
export const startDeletePet = owned(DeletePetConversation.built, ownedStartup);
export const startInviteCaregiver = owned(
	InviteCaregiverConversation.built,
	ownedStartup,
);
export const startRemoveCaregiver = owned(
	RemoveCaregiverConversation.built,
	ownedStartup,
);
export const startListCaregivers = owned(
	ListCaregiversConversation.built,
	ownedStartup,
);

export const startPetInvitations = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const invitations = yield* ListPetInvitations.execute(actor(current));
	const first = invitations[0];
	if (first === undefined) {
		yield* (yield* MessageContext.MessageContext).reply(
			'Você não tem convites pendentes.',
		);
		return;
	}
	yield* start(PetInvitationsConversation.built, {
		...actor(current),
		invitations: [
			{
				petId: first.pet.id,
				petName: first.pet.name,
				ownerDisplayName: first.ownerDisplayName,
			},
			...invitations
				.slice(1)
				.map(({ pet, ownerDisplayName }) => ({
					petId: pet.id,
					petName: pet.name,
					ownerDisplayName,
				})),
		],
	});
});

export const startStopCaring = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const caregivers = yield* PetCaregiverRepository;
	const pets = yield* PetRepository;
	const relations = yield* caregivers.listAcceptedForUser(current.user.id);
	const caredPets = (yield* Effect.forEach(relations, (relation) =>
		pets.findById(relation.petId),
	)).filter((pet) => pet !== undefined);
	const first = caredPets[0];
	if (first === undefined) {
		yield* (yield* MessageContext.MessageContext).reply(
			'Você não está cuidando de nenhum pet.',
		);
		return;
	}
	yield* start(StopCaringConversation.built, {
		...actor(current),
		pets: [
			{ id: first.id, name: first.name },
			...caredPets.slice(1).map(({ id, name }) => ({ id, name })),
		],
	});
});

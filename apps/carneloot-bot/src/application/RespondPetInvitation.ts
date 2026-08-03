import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
} from '../domain/caregivers/CaregiverError.js';
import type { PetId } from '../domain/Ids.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import { currentActor, displayName } from './CaregiverAccess.js';
import type { CaregiverActor } from './CaregiverResult.js';

export const execute = Effect.fn('RespondPetInvitation.execute')(
	(actor: CaregiverActor, petId: PetId, response: 'accepted' | 'rejected') =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient;
			const caregivers = yield* PetCaregiverRepository;
			const pets = yield* PetRepository;
			const users = yield* UserRepository;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const caregiver = yield* currentActor(actor);
					const pet = yield* pets.lockById(petId);
					const relation = yield* caregivers.lock(petId, actor.actorId);
					if (relation === undefined)
						return yield* Effect.fail(
							new CaregiverInvitationNotFound({
								message: 'Invitation was not found',
							}),
						);
					if (relation.status !== 'pending')
						return yield* Effect.fail(
							new CaregiverInvitationNotPending({
								message: 'Invitation is not pending',
							}),
						);
					if (pet === undefined)
						return yield* Effect.fail(
							new CaregiverAccessLost({ message: 'Pet no longer exists' }),
						);
					const owner = yield* users.findById(actor.botId, pet.ownerId);
					const updated = yield* caregivers.setPendingResponse(
						petId,
						actor.actorId,
						response,
						yield* DateTime.now,
					);
					const verb = response === 'accepted' ? 'aceitou' : 'rejeitou';
					return {
						value: updated,
						notices: [
							{
								chatId: owner.profile.privateChatId,
								text: `${displayName(caregiver)} ${verb} o convite para cuidar do pet ${pet.name}.`,
							},
						],
					};
				}),
			);
		}),
);

import * as PgClient from '@effect/sql-pg/PgClient';
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

export const execute = Effect.fn('StopCaring.execute')(
	(actor: CaregiverActor, petId: PetId) =>
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
								message: 'Caregiver relationship was not found',
							}),
						);
					if (relation.status !== 'accepted')
						return yield* Effect.fail(
							new CaregiverInvitationNotPending({
								message: 'Only an accepted caregiver can stop caring',
							}),
						);
					if (pet === undefined)
						return yield* Effect.fail(
							new CaregiverAccessLost({ message: 'Pet no longer exists' }),
						);
					const owner = yield* users.findById(actor.botId, pet.ownerId);
					if (!(yield* caregivers.remove(petId, actor.actorId)))
						return yield* Effect.fail(
							new CaregiverAccessLost({
								message: 'Caregiver relationship changed',
							}),
						);
					return {
						value: relation,
						notices: [
							{
								chatId: owner.profile.privateChatId,
								text: `${displayName(caregiver)} parou de cuidar do pet ${pet.name}.`,
							},
						],
					};
				}),
			);
		}),
);

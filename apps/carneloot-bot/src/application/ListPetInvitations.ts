import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import { CaregiverAccessLost } from '../domain/caregivers/CaregiverError.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import { currentActor, displayName } from './CaregiverAccess.js';
import type { CaregiverActor } from './CaregiverResult.js';

export const execute = (actor: CaregiverActor) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const caregivers = yield* PetCaregiverRepository;
		const pets = yield* PetRepository;
		const users = yield* UserRepository;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* currentActor(actor);
				return yield* Effect.forEach(
					yield* caregivers.listPendingForUser(actor.actorId),
					(relation) =>
						Effect.gen(function* () {
							const pet = yield* pets.lockById(relation.petId);
							const locked = yield* caregivers.lock(
								relation.petId,
								actor.actorId,
							);
							if (locked?.status !== 'pending')
								return yield* Effect.fail(
									new CaregiverAccessLost({ message: 'Invitation changed' }),
								);
							if (pet === undefined)
								return yield* Effect.fail(
									new CaregiverAccessLost({ message: 'Pet no longer exists' }),
								);
							const owner = yield* users.findById(actor.botId, pet.ownerId);
							return {
								relation: locked,
								pet,
								ownerDisplayName: displayName(owner),
							};
						}),
				);
			}),
		);
	});

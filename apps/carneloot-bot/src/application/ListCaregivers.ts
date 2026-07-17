import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import { CaregiverAccessLost } from '../domain/caregivers/CaregiverError.js';
import { statusLabel } from '../domain/caregivers/PetCaregiver.js';
import type { PetId } from '../domain/Ids.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import { currentActor, displayName } from './CaregiverAccess.js';
import type { CaregiverActor } from './CaregiverResult.js';

export const execute = (actor: CaregiverActor, petId: PetId) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const pets = yield* PetRepository;
		const caregivers = yield* PetCaregiverRepository;
		const users = yield* UserRepository;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* currentActor(actor);
				const pet = yield* pets.lockById(petId);
				if (pet === undefined || pet.ownerId !== actor.actorId)
					return yield* Effect.fail(
						new CaregiverAccessLost({ message: 'Pet is not owned by actor' }),
					);
				return yield* Effect.forEach(
					yield* caregivers.listForPet(petId),
					(relation) =>
						Effect.map(
							users.findById(actor.botId, relation.caregiverUserId),
							(user) => ({
								relation,
								displayName: displayName(user),
								statusLabel: statusLabel(relation.status),
							}),
						),
				);
			}),
		);
	});

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
} from '../domain/caregivers/CaregiverError.js';
import type { PetId, UserId } from '../domain/Ids.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import { currentActor } from './CaregiverAccess.js';
import type { CaregiverActor } from './CaregiverResult.js';

export const execute = Effect.fn('RemoveCaregiver.execute')
	((
	actor: CaregiverActor,
	petId: PetId,
	caregiverUserId: UserId,
) =>
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
				const relation = yield* caregivers.lock(petId, caregiverUserId);
				if (relation === undefined)
					return yield* Effect.fail(
						new CaregiverInvitationNotFound({
							message: 'Caregiver relationship was not found',
						}),
					);
				const removed = yield* users.findById(actor.botId, caregiverUserId);
				if (!(yield* caregivers.remove(petId, caregiverUserId)))
					return yield* Effect.fail(
						new CaregiverAccessLost({
							message: 'Caregiver relationship changed',
						}),
					);
				return {
					value: relation,
					notices: [
						{
							chatId: removed.profile.privateChatId,
							text: `Você não cuida mais do pet ${pet.name}.`,
						},
					],
				};
			}),
		);
	}));

import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import {
	CaregiverAccessLost,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
	CaregiverUsernameNotFound,
} from '../domain/caregivers/CaregiverError.js';
import type { PetId } from '../domain/Ids.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import { currentActor, displayName } from './CaregiverAccess.js';
import type { CaregiverActor, MutationResult } from './CaregiverResult.js';

export const execute = (actor: CaregiverActor, petId: PetId, username: string) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const users = yield* UserRepository;
		const pets = yield* PetRepository;
		const caregivers = yield* PetCaregiverRepository;
		return yield* sql.withTransaction(Effect.gen(function* () {
			const owner = yield* currentActor(actor);
			const pet = yield* pets.lockById(petId);
			if (pet === undefined || pet.ownerId !== actor.actorId)
				return yield* Effect.fail(new CaregiverAccessLost({ message: 'Pet is not owned by actor' }));
			const normalized = username.trim().replace(/^@/u, '').toLowerCase();
			if (normalized.length === 0)
				return yield* Effect.fail(new CaregiverUsernameNotFound({ message: 'Caregiver username is empty' }));
			const matches = yield* users.findByUsername(actor.botId, normalized);
			if (matches.length === 0)
				return yield* Effect.fail(new CaregiverUsernameNotFound({ message: 'Caregiver username was not found' }));
			if (matches.length !== 1)
				return yield* Effect.fail(new CaregiverUsernameAmbiguous({ message: 'Caregiver username is ambiguous' }));
			const [invitee] = matches;
			if (invitee === undefined) return yield* Effect.fail(new CaregiverUsernameNotFound({ message: 'Caregiver username was not found' }));
			if (invitee.user.id === actor.actorId)
				return yield* Effect.fail(new CaregiverSelfInvitation({ message: 'Owner cannot invite self' }));
			const relation = yield* caregivers.insertPending(petId, invitee.user.id, yield* DateTime.now);
			return { value: relation, notices: [{ chatId: invitee.profile.privateChatId, text: `${displayName(owner)} convidou você para cuidar do pet ${pet.name}.\nUse /convites_pet para responder.` }] } satisfies MutationResult<typeof relation>;
		}));
	});

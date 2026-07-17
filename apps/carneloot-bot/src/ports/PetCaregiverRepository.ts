import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
import type * as Effect from 'effect/Effect';

import type {
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
} from '../domain/caregivers/CaregiverError.js';
import type { PetCaregiver } from '../domain/caregivers/PetCaregiver.js';
import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { PetId, UserId } from '../domain/Ids.js';

export interface PetCaregiverRepositoryService {
	readonly find: (
		petId: PetId,
		caregiverUserId: UserId,
	) => Effect.Effect<PetCaregiver | undefined, DomainPersistenceError>;
	readonly lock: (
		petId: PetId,
		caregiverUserId: UserId,
	) => Effect.Effect<PetCaregiver | undefined, DomainPersistenceError>;
	readonly insertPending: (
		petId: PetId,
		caregiverUserId: UserId,
		now: DateTime.Utc,
	) => Effect.Effect<
		PetCaregiver,
		DomainPersistenceError | CaregiverRelationshipExists
	>;
	readonly setPendingResponse: (
		petId: PetId,
		caregiverUserId: UserId,
		status: 'accepted' | 'rejected',
		now: DateTime.Utc,
	) => Effect.Effect<
		PetCaregiver,
		DomainPersistenceError | CaregiverInvitationNotPending
	>;
	readonly remove: (
		petId: PetId,
		caregiverUserId: UserId,
	) => Effect.Effect<boolean, DomainPersistenceError>;
	readonly listForPet: (
		petId: PetId,
	) => Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>;
	readonly listPendingForUser: (
		caregiverUserId: UserId,
	) => Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>;
	readonly listAcceptedForUser: (
		caregiverUserId: UserId,
	) => Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>;
}

export class PetCaregiverRepository extends Context.Service<
	PetCaregiverRepository,
	PetCaregiverRepositoryService
>()('carneloot/PetCaregiverRepository') {}

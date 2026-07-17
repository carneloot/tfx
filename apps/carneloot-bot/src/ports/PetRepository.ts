import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type {
	DomainPersistenceError,
	PetNameAlreadyExists,
	UserNotRegistered,
} from '../domain/DomainError.js';
import type { PetId, UserId } from '../domain/Ids.js';
import type { Pet, PetName } from '../domain/Pet.js';

export interface PetRepositoryService {
	readonly findById: (
		petId: PetId,
	) => Effect.Effect<Pet | undefined, DomainPersistenceError>;
	readonly lockById: (
		petId: PetId,
	) => Effect.Effect<Pet | undefined, DomainPersistenceError>;
	readonly addOwned: (
		ownerId: UserId,
		name: PetName,
	) => Effect.Effect<
		Pet,
		DomainPersistenceError | PetNameAlreadyExists | UserNotRegistered
	>;
	readonly listOwned: (
		ownerId: UserId,
	) => Effect.Effect<
		ReadonlyArray<Pet>,
		DomainPersistenceError | UserNotRegistered
	>;
	readonly listAccessible: (
		userId: UserId,
	) => Effect.Effect<
		ReadonlyArray<Pet>,
		DomainPersistenceError | UserNotRegistered
	>;
}
export class PetRepository extends Context.Service<
	PetRepository,
	PetRepositoryService
>()('carneloot/PetRepository') {}

import * as Effect from 'effect/Effect';

import type { UserId } from '../domain/Ids.js';
import { type Pet, petNameKey } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';

export interface ListedPet {
	readonly pet: Pet;
	readonly role: 'owner' | 'caregiver';
}

export const execute = Effect.fn('ListPets.execute')
	((actorId: UserId) =>
	Effect.map(
		Effect.flatMap(PetRepository, (repository) =>
			repository.listAccessible(actorId),
		),
		(pets): ReadonlyArray<ListedPet> =>
			pets
				.map((pet) => ({
					pet,
					role:
						pet.ownerId === actorId
							? ('owner' as const)
							: ('caregiver' as const),
				}))
				.sort((left, right) => {
					const leftKey = petNameKey(left.pet.name);
					const rightKey = petNameKey(right.pet.name);
					if (leftKey < rightKey) return -1;
					if (leftKey > rightKey) return 1;
					return left.pet.id < right.pet.id
						? -1
						: left.pet.id > right.pet.id
							? 1
							: 0;
				}),
	));

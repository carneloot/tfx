import * as Effect from 'effect/Effect';

import type { PetFoodEntry } from '../domain/pet-food/PetFood.js';
import type { Pet } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';
import * as AddFood from './AddFood.js';
import type { ParsedFoodInput, SourceInput } from './AddFood.js';
import type { PetFoodAccess } from './PetFoodAccess.js';

export type AddFoodToAllItem =
	| { readonly _tag: 'Added'; readonly pet: Pet; readonly entry: PetFoodEntry }
	| {
			readonly _tag: 'Replayed';
			readonly pet: Pet;
			readonly entry: PetFoodEntry;
	  }
	| { readonly _tag: 'SetupMissing'; readonly pet: Pet }
	| { readonly _tag: 'Duplicate'; readonly pet: Pet }
	| { readonly _tag: 'AccessLost'; readonly pet: Pet };

export interface AddFoodToAllResult {
	readonly items: ReadonlyArray<AddFoodToAllItem>;
}

export const execute = Effect.fn('AddFoodToAll.execute')
	((
	access: Omit<PetFoodAccess, 'petId'>,
	input: ParsedFoodInput,
	source: SourceInput,
) =>
	Effect.gen(function* () {
		const repository = yield* PetRepository;
		const pets = yield* repository.listAccessible(access.actorId);
		const items = yield* Effect.forEach(
			pets,
			(pet) =>
				AddFood.execute({ ...access, petId: pet.id }, input, source).pipe(
					Effect.map((result) => ({
						_tag: result.replayed ? ('Replayed' as const) : ('Added' as const),
						pet,
						entry: result.entry,
					})),
					Effect.catchTags({
						PetFoodSetupMissing: () =>
							Effect.succeed({ _tag: 'SetupMissing' as const, pet }),
						DuplicateFoodEntry: () =>
							Effect.succeed({ _tag: 'Duplicate' as const, pet }),
						PetAccessDenied: () =>
							Effect.succeed({ _tag: 'AccessLost' as const, pet }),
					}),
				),
			{ concurrency: 4 },
		);
		return { items } satisfies AddFoodToAllResult;
	}));

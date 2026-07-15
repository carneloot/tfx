import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AddPet from '../src/application/AddPet.js';
import * as ListPets from '../src/application/ListPets.js';
import { PetNameAlreadyExists } from '../src/domain/DomainError.js';
import { UserId } from '../src/domain/Ids.js';
import { PetRepository } from '../src/ports/PetRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const layer = Layer.succeed(PetRepository, {
	addOwned: (_ownerId, name) =>
		name === 'Rex'
			? Effect.succeed({
					id: '00000000-0000-4000-8000-000000000002' as never,
					ownerId,
					name,
					createdAt: 0,
					updatedAt: 0,
				})
			: Effect.fail(new PetNameAlreadyExists({ message: 'duplicate' })),
	listOwned: () => Effect.succeed([]),
});
describe('pet application services', () => {
	it('normalizes before repository insertion', async () => {
		const pet = await Effect.runPromise(
			Effect.provide(AddPet.execute(ownerId, ' Rex '), layer),
		);
		expect(pet.name).toBe('Rex');
	});
	it('returns empty owned projections', async () => {
		expect(
			await Effect.runPromise(Effect.provide(ListPets.execute(ownerId), layer)),
		).toEqual([]);
	});
});

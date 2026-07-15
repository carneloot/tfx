import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import type { UserId } from '../domain/Ids.js';
import { PetName } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';
export const execute = (ownerId: UserId, input: unknown) =>
	Effect.gen(function* () {
		const name = yield* Schema.decodeUnknownEffect(PetName)(input).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({ message: 'Invalid pet name', cause }),
			),
		);
		const repository = yield* PetRepository;
		return yield* repository.addOwned(ownerId, name);
	});

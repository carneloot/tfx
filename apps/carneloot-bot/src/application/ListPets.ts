import * as Effect from 'effect/Effect';

import type { UserId } from '../domain/Ids.js';
import { PetRepository } from '../ports/PetRepository.js';
export const execute = (ownerId: UserId) =>
	Effect.flatMap(PetRepository, (repository) => repository.listOwned(ownerId));

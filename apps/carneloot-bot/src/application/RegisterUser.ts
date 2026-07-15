import * as Effect from 'effect/Effect';

import type { TelegramProfile } from '../domain/User.js';
import { UserRepository } from '../ports/UserRepository.js';
export const execute = (profile: TelegramProfile) =>
	Effect.flatMap(UserRepository, (repository) =>
		repository.registerTelegramProfile(profile),
	);

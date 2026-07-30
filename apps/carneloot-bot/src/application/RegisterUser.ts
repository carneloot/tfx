import * as Effect from 'effect/Effect';

import type { TelegramProfile } from '../domain/User.js';
import { UserRepository } from '../ports/UserRepository.js';
export const execute = Effect.fn('RegisterUser.execute')(
	(profile: TelegramProfile) =>
		Effect.gen(function* () {
			const repository = yield* UserRepository;
			const registered = yield* repository.registerTelegramProfile(profile);
			yield* Effect.logInfo('carneloot.user.profile_saved').pipe(
				Effect.annotateLogs({
					botId: registered.profile.botId,
					userId: registered.user.id,
				}),
			);
			return registered;
		}),
);

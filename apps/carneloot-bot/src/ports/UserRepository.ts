import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type {
	DomainPersistenceError,
	UserNotRegistered,
} from '../domain/DomainError.js';
import type { BotId, TelegramUserId } from '../domain/Ids.js';
import type { RegisteredUser, TelegramProfile } from '../domain/User.js';

export interface UserRepositoryService {
	readonly registerTelegramProfile: (
		profile: TelegramProfile,
	) => Effect.Effect<RegisteredUser, DomainPersistenceError>;
	readonly findByTelegram: (
		botId: BotId,
		telegramUserId: TelegramUserId,
	) => Effect.Effect<
		RegisteredUser,
		DomainPersistenceError | UserNotRegistered
	>;
}
export class UserRepository extends Context.Service<
	UserRepository,
	UserRepositoryService
>()('carneloot/UserRepository') {}

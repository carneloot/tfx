import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { UserId } from '../domain/Ids.js';
import type { ApiKeyHash } from '../domain/notifications/ApiKey.js';

export interface ApiKeyRepositoryService {
	readonly hasForUser: (
		userId: UserId,
	) => Effect.Effect<boolean, DomainPersistenceError>;
	readonly replaceForUser: (
		userId: UserId,
		keyHash: ApiKeyHash,
	) => Effect.Effect<void, DomainPersistenceError>;
	readonly findUserIdByHash: (
		keyHash: ApiKeyHash,
	) => Effect.Effect<UserId | undefined, DomainPersistenceError>;
}
export class ApiKeyRepository extends Context.Service<
	ApiKeyRepository,
	ApiKeyRepositoryService
>()('carneloot/ApiKeyRepository') {}

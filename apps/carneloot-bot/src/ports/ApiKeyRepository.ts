import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { UserId } from '../domain/Ids.js';

export class ApiKeyRepository extends Context.Service<
	ApiKeyRepository,
	{
		readonly findOwner: (
			hash: string,
		) => Effect.Effect<UserId | undefined, DomainPersistenceError>;
		/** Existing keys can only be replaced after explicit confirmation. */
		readonly replace: (input: {
			readonly id: string;
			readonly userId: UserId;
			readonly hash: string;
			readonly confirmed: boolean;
		}) => Effect.Effect<boolean, DomainPersistenceError>;
	}
>()('carneloot/ApiKeyRepository') {}

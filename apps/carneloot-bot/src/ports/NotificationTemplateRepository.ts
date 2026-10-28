import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { BotId, UserId } from '../domain/Ids.js';
import type { RecipientInput } from './NotificationRepository.js';

export interface NotificationTemplate {
	readonly id: string;
	readonly message: string;
	readonly recipients: ReadonlyArray<
		| Omit<Extract<RecipientInput, { _tag: 'Reachable' }>, 'id'>
		| Omit<Extract<RecipientInput, { _tag: 'Unreachable' }>, 'id'>
	>;
}
export class NotificationTemplateRepository extends Context.Service<
	NotificationTemplateRepository,
	{
		readonly find: (
			botId: BotId,
			ownerId: UserId,
			keyword: string,
		) => Effect.Effect<
			NotificationTemplate | undefined,
			DomainPersistenceError
		>;
	}
>()('carneloot/NotificationTemplateRepository') {}

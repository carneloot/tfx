import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { UserId } from '../domain/Ids.js';
import type {
	NotificationKeyword,
	NotificationTemplate,
} from '../domain/notifications/NotificationTemplate.js';

export interface ResolvedNotificationTemplate {
	readonly template: NotificationTemplate;
	readonly subscriberUserIds: ReadonlyArray<UserId>;
}
export interface NotificationTemplateRepositoryService {
	readonly findByOwnerAndKeyword: (
		ownerUserId: UserId,
		keyword: NotificationKeyword,
	) => Effect.Effect<
		ResolvedNotificationTemplate | undefined,
		DomainPersistenceError
	>;
}
export class NotificationTemplateRepository extends Context.Service<
	NotificationTemplateRepository,
	NotificationTemplateRepositoryService
>()('carneloot/NotificationTemplateRepository') {}

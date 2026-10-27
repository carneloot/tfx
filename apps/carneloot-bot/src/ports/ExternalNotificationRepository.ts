import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { BotId, TelegramChatId } from '../domain/Ids.js';
import type { ExternalNotificationResult } from '../domain/notifications/ExternalNotification.js';
import type { EventId } from '../domain/notifications/NotificationEvent.js';
import type {
	EventInput,
	NotificationRepositoryError,
	RecipientInput,
} from './NotificationRepository.js';

export class ExternalNotificationRepository extends Context.Service<
	ExternalNotificationRepository,
	{
		readonly create: (
			event: EventInput,
			templateId: string | null,
			text: string,
			recipients: ReadonlyArray<RecipientInput>,
			replyToMessageId?: number,
		) => Effect.Effect<EventId, NotificationRepositoryError>;
		readonly payload: (
			eventId: EventId,
		) => Effect.Effect<
			| { readonly text: string; readonly replyToMessageId: number | null }
			| undefined,
			NotificationRepositoryError
		>;
		readonly result: (
			eventId: EventId,
		) => Effect.Effect<ExternalNotificationResult, NotificationRepositoryError>;
		readonly failPending: (
			eventId: EventId,
		) => Effect.Effect<void, NotificationRepositoryError>;
		readonly ownerMessage: (
			eventId: EventId,
			botId: BotId,
		) => Effect.Effect<
			| { readonly chatId: TelegramChatId; readonly messageId: number }
			| undefined,
			NotificationRepositoryError
		>;
	}
>()('carneloot/ExternalNotificationRepository') {}

import { Data } from 'effect';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { BotId, PetId, TelegramChatId, UserId } from '../domain/Ids.js';
import type { SafeError } from '../domain/notifications/DeliveryOutcome.js';
import type {
	DeliveryChannel,
	DeliveryId,
	NotificationDelivery,
} from '../domain/notifications/NotificationDelivery.js';
import type {
	EventId,
	NotificationEvent,
} from '../domain/notifications/NotificationEvent.js';
import type { RecipientRole } from '../domain/notifications/RecipientRole.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';

export class NotificationRepositoryError extends Data.TaggedError(
	'NotificationRepositoryError',
)<{
	readonly reason:
		| 'PersistenceFailure'
		| 'InvariantViolation'
		| 'NotFound'
		| 'Conflict';
	readonly message: string;
	readonly cause?: unknown;
}> {}
export interface EventInput {
	readonly id: EventId;
	readonly botId: BotId;
	readonly kind: string;
	readonly ownerUserId: UserId;
	readonly petId: PetId | null;
	readonly foodEntryId: FoodEntryId | null;
	readonly scheduledFor: number | null;
	readonly dedupeKey: string;
	readonly now: number;
}
export interface RecipientInput {
	readonly id: DeliveryId;
	readonly recipientUserId: UserId;
	readonly recipientChatId: TelegramChatId;
	readonly recipientRole: RecipientRole;
	readonly channel: typeof DeliveryChannel.Type;
}
export interface DeliveryToken {
	readonly id: DeliveryId;
	readonly generation: number;
}
export interface DeliveryClaim {
	readonly token: DeliveryToken;
	readonly delivery: NotificationDelivery;
}
export interface EventSummary {
	readonly pending: number;
	readonly sending: number;
	readonly retryableFailed: number;
	readonly terminal: number;
	readonly completed: boolean;
	readonly earliestRetryAt: number | null;
}
export interface NotificationRepositoryService {
	readonly createEvent: (
		input: EventInput,
	) => Effect.Effect<NotificationEvent, NotificationRepositoryError>;
	readonly cancelEvent: (
		id: EventId,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly attachJob: (
		id: EventId,
		jobId: string,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly getDispatchContext: (
		id: EventId,
	) => Effect.Effect<
		NotificationEvent | undefined,
		NotificationRepositoryError
	>;
	readonly materializeRecipients: (
		eventId: EventId,
		recipients: ReadonlyArray<RecipientInput>,
		now: number,
	) => Effect.Effect<
		ReadonlyArray<NotificationDelivery>,
		NotificationRepositoryError
	>;
	readonly recoverExpired: (
		now: number,
	) => Effect.Effect<number, NotificationRepositoryError>;
	readonly claimNext: (
		eventId: EventId,
		now: number,
		leaseDuration: number,
	) => Effect.Effect<DeliveryClaim | undefined, NotificationRepositoryError>;
	readonly finalizeSent: (
		token: DeliveryToken,
		botId: BotId,
		messageId: number,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly finalizeFailed: (
		token: DeliveryToken,
		error: SafeError,
		retryable: boolean,
		retryAt: number | null,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly finalizeUnknown: (
		token: DeliveryToken,
		error: SafeError,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly reconcileUnknownAsSent: (
		token: DeliveryToken,
		botId: BotId,
		messageId: number,
		now: number,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly summarizeAndComplete: (
		eventId: EventId,
		now: number,
	) => Effect.Effect<EventSummary, NotificationRepositoryError>;
}
export class NotificationRepository extends Context.Service<
	NotificationRepository,
	NotificationRepositoryService
>()('carneloot/NotificationRepository') {}

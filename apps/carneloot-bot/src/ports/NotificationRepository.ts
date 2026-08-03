import { Data } from 'effect';
import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
import type * as Duration from 'effect/Duration';
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
import type { Uuid } from '../domain/Uuid.js';

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
	readonly scheduledFor: DateTime.Utc | null;
	readonly foodTimestampExplicit: boolean;
	readonly dedupeKey: string;
	readonly now: DateTime.Utc;
}
interface RecipientBase {
	readonly id: DeliveryId;
	readonly recipientUserId: UserId;
	readonly recipientRole: RecipientRole;
	readonly channel: typeof DeliveryChannel.Type;
}
export type RecipientInput =
	| (RecipientBase & {
			readonly _tag: 'Reachable';
			readonly recipientChatId: TelegramChatId;
	  })
	| (RecipientBase & {
			readonly _tag: 'Unreachable';
			readonly error: SafeError;
	  });
export interface ExternalEventPayload {
	readonly templateId: typeof Uuid.Type | null;
	readonly renderedMessage: string;
}
export interface DeliveryToken {
	readonly id: DeliveryId;
	readonly generation: number;
}
export interface DeliveryClaim {
	readonly token: DeliveryToken;
	readonly delivery: NotificationDelivery;
}
export interface CancelledActiveEvent {
	readonly eventId: EventId;
	readonly jobId: string | null;
}
export interface NotificationReplyContext {
	readonly delivery: NotificationDelivery;
	readonly event: NotificationEvent;
}
export interface EventSummary {
	readonly pending: number;
	readonly sending: number;
	readonly retryableFailed: number;
	readonly terminal: number;
	readonly sent: number;
	readonly failed: number;
	readonly unknown: number;
	readonly failures: ReadonlyArray<SafeError>;
	readonly completed: boolean;
	readonly earliestRetryAt: DateTime.Utc | null;
	readonly earliestSendingLeaseExpiry: DateTime.Utc | null;
}
export interface NotificationRepositoryService {
	readonly createEvent: (
		input: EventInput,
	) => Effect.Effect<NotificationEvent, NotificationRepositoryError>;
	readonly createExternalEvent: (
		input: EventInput,
		payload: ExternalEventPayload,
		recipients: ReadonlyArray<RecipientInput>,
	) => Effect.Effect<
		{
			readonly event: NotificationEvent;
			readonly deliveries: ReadonlyArray<NotificationDelivery>;
		},
		NotificationRepositoryError
	>;
	readonly cancelActiveForPet: (
		botId: BotId,
		petId: PetId,
		now: DateTime.Utc,
	) => Effect.Effect<
		ReadonlyArray<CancelledActiveEvent>,
		NotificationRepositoryError
	>;
	readonly reviveCancelledEvent: (
		id: EventId,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly cancelEvent: (
		id: EventId,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly attachJob: (
		id: EventId,
		jobId: string,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly getDispatchContext: (
		id: EventId,
	) => Effect.Effect<
		NotificationEvent | undefined,
		NotificationRepositoryError
	>;
	readonly lockForMaterialization: (
		eventId: EventId,
	) => Effect.Effect<
		NotificationEvent | undefined,
		NotificationRepositoryError
	>;
	readonly markRecipientsMaterialized: (
		eventId: EventId,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly materializeRecipients: (
		eventId: EventId,
		recipients: ReadonlyArray<RecipientInput>,
		now: DateTime.Utc,
	) => Effect.Effect<
		ReadonlyArray<NotificationDelivery>,
		NotificationRepositoryError
	>;
	readonly recoverExpired: (
		eventId: EventId,
		now: DateTime.Utc,
	) => Effect.Effect<number, NotificationRepositoryError>;
	readonly recoverAllExpired: (
		now: DateTime.Utc,
	) => Effect.Effect<number, NotificationRepositoryError>;
	readonly claimNext: (
		eventId: EventId,
		now: DateTime.Utc,
		leaseDuration: Duration.Duration,
	) => Effect.Effect<DeliveryClaim | undefined, NotificationRepositoryError>;
	readonly finalizeSent: (
		token: DeliveryToken,
		botId: BotId,
		messageId: number,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly finalizeFailed: (
		token: DeliveryToken,
		error: SafeError,
		retryable: boolean,
		retryAt: DateTime.Utc | null,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly finalizeUnknown: (
		token: DeliveryToken,
		error: SafeError,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly finalizeUnattempted: (
		eventId: EventId,
		error: SafeError,
		now: DateTime.Utc,
	) => Effect.Effect<number, NotificationRepositoryError>;
	readonly reconcileUnknownAsSent: (
		token: DeliveryToken,
		botId: BotId,
		messageId: number,
		now: DateTime.Utc,
	) => Effect.Effect<boolean, NotificationRepositoryError>;
	readonly findSentByTelegramMessage: (
		botId: BotId,
		chatId: TelegramChatId,
		messageId: number,
	) => Effect.Effect<
		NotificationReplyContext | undefined,
		NotificationRepositoryError
	>;
	readonly summarizeAndComplete: (
		eventId: EventId,
		now: DateTime.Utc,
	) => Effect.Effect<EventSummary, NotificationRepositoryError>;
}
export class NotificationRepository extends Context.Service<
	NotificationRepository,
	NotificationRepositoryService
>()('carneloot/NotificationRepository') {}

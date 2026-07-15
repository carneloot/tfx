import { Data } from 'effect';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { BotId, TelegramChatId, UserId } from '../domain/Ids.js';
import type { SafeError } from '../domain/notifications/DeliveryOutcome.js';
import type { RecipientRole } from '../domain/notifications/RecipientRole.js';

export class NotificationRecipientsError extends Data.TaggedError(
	'NotificationRecipientsError',
)<{ readonly message: string; readonly cause?: unknown }> {}
export type ResolvedRecipient =
	| {
			readonly _tag: 'Reachable';
			readonly recipientUserId: UserId;
			readonly recipientChatId: TelegramChatId;
			readonly recipientRole: RecipientRole;
			readonly channel: 'telegram';
	  }
	| {
			readonly _tag: 'Unreachable';
			readonly recipientUserId: UserId;
			readonly recipientRole: RecipientRole;
			readonly channel: 'telegram';
			readonly error: SafeError;
	  };
export interface NotificationRecipientsService {
	readonly resolveOwner: (
		botId: BotId,
		ownerUserId: UserId,
	) => Effect.Effect<ResolvedRecipient, NotificationRecipientsError>;
}
export class NotificationRecipients extends Context.Service<
	NotificationRecipients,
	NotificationRecipientsService
>()('carneloot/NotificationRecipients') {}

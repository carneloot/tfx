import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { TelegramChatId } from '../domain/Ids.js';
import { owner } from '../domain/notifications/RecipientRole.js';
import {
	NotificationRecipients,
	NotificationRecipientsError,
	type NotificationRecipientsService,
	type ResolvedRecipient,
} from '../ports/NotificationRecipients.js';

const Row = Schema.Struct({
	private_chat_id: Schema.Union([Schema.String, Schema.Number]),
});
export const layer: Layer.Layer<
	NotificationRecipients,
	never,
	PgClient.PgClient
> = Layer.effect(
	NotificationRecipients,
	Effect.map(PgClient.PgClient, (sql) => {
		const service: NotificationRecipientsService = {
			resolveOwner: (botId, ownerUserId) =>
				Effect.flatMap(
					sql<
						Record<string, unknown>
					>`SELECT private_chat_id FROM carneloot.telegram_identities WHERE bot_id=${botId} AND user_id=${ownerUserId}::uuid`,
					(
						rows,
					): Effect.Effect<ResolvedRecipient, NotificationRecipientsError> => {
						if (rows[0] === undefined)
							return Effect.succeed({
								_tag: 'Unreachable' as const,
								recipientUserId: ownerUserId,
								recipientRole: owner,
								channel: 'telegram' as const,
								error: {
									code: 'MissingTelegramIdentity',
									message: 'Recipient has no Telegram identity for this bot',
								},
							});
						return Effect.try({
							try: () => {
								const row = Schema.decodeUnknownSync(Row)(rows[0]);
								const chatId = Schema.decodeUnknownSync(TelegramChatId)(
									Number(row.private_chat_id),
								);
								return {
									_tag: 'Reachable' as const,
									recipientUserId: ownerUserId,
									recipientChatId: chatId,
									recipientRole: owner,
									channel: 'telegram' as const,
								};
							},
							catch: (cause) =>
								new NotificationRecipientsError({
									message: 'Malformed Telegram recipient row',
									cause,
								}),
						});
					},
				).pipe(
					Effect.mapError((cause) =>
						cause instanceof NotificationRecipientsError
							? cause
							: new NotificationRecipientsError({
									message: 'Recipient lookup failed',
									cause,
								}),
					),
				),
		};
		return service;
	}),
);

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { TelegramChatId, UserId } from '../domain/Ids.js';
import { caregiver, owner } from '../domain/notifications/RecipientRole.js';
import {
	NotificationRecipients,
	NotificationRecipientsError,
	type NotificationRecipientsService,
	type PetNotificationRecipient,
	type ResolvedRecipient,
} from '../ports/NotificationRecipients.js';

const OwnerRow = Schema.Struct({
	private_chat_id: Schema.Union([Schema.String, Schema.Number]),
});
const PetRecipientRow = Schema.Struct({
	user_id: UserId,
	role: Schema.Literals(['owner', 'caregiver']),
	private_chat_id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
});
const Recipient = Data.taggedEnum<ResolvedRecipient>();

const unreachable = (
	userId: UserId,
	role: typeof owner | typeof caregiver,
): ResolvedRecipient =>
	Recipient.Unreachable({
		recipientUserId: userId,
		recipientRole: role,
		channel: 'telegram',
		error: {
			code: 'MissingTelegramIdentity',
			message: 'Recipient has no Telegram identity for this bot',
		},
	});

const decodePetRecipient = (input: unknown): PetNotificationRecipient => {
	const row = Schema.decodeUnknownSync(PetRecipientRow)(input);
	const recipientRole = row.role === 'owner' ? owner : caregiver;
	const resolution =
		row.private_chat_id === null
			? unreachable(row.user_id, recipientRole)
			: Recipient.Reachable({
					recipientUserId: row.user_id,
					recipientChatId: Schema.decodeUnknownSync(TelegramChatId)(
						Number(row.private_chat_id),
					),
					recipientRole,
					channel: 'telegram',
				});
	return { userId: row.user_id, role: row.role, resolution };
};

export const layer = Layer.effect(
	NotificationRecipients,
	Effect.map(PgClient.PgClient, (sql) => {
		const service = {
			resolveOwner: (botId, ownerUserId) =>
				Effect.flatMap(
					sql<
						Record<string, unknown>
					>`SELECT private_chat_id FROM carneloot.telegram_identities WHERE bot_id=${botId} AND user_id=${ownerUserId}::uuid`,
					(
						rows,
					): Effect.Effect<ResolvedRecipient, NotificationRecipientsError> => {
						if (rows[0] === undefined)
							return Effect.succeed(unreachable(ownerUserId, owner));
						return Effect.try({
							try: () => {
								const row = Schema.decodeUnknownSync(OwnerRow)(rows[0]);
								const chatId = Schema.decodeUnknownSync(TelegramChatId)(
									Number(row.private_chat_id),
								);
								return Recipient.Reachable({
									recipientUserId: ownerUserId,
									recipientChatId: chatId,
									recipientRole: owner,
									channel: 'telegram',
								});
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
			resolvePetRecipients: (botId, petId, options) => {
				const excludedUserId = options?.excludeUserId ?? null;
				return sql<Record<string, unknown>>`
					WITH candidates AS (
						SELECT p.owner_id AS user_id, 'owner'::text AS role, 0 AS role_order
						FROM carneloot.pets p
						WHERE p.id=${petId}::uuid
						UNION ALL
						SELECT pc.caregiver_user_id AS user_id, 'caregiver'::text AS role, 1 AS role_order
						FROM carneloot.pet_caregivers pc
						JOIN carneloot.pets p ON p.id=pc.pet_id
						WHERE pc.pet_id=${petId}::uuid
							AND pc.status='accepted'
							AND pc.caregiver_user_id<>p.owner_id
					)
					SELECT c.user_id, c.role, ti.private_chat_id
					FROM candidates c
					LEFT JOIN carneloot.telegram_identities ti
						ON ti.bot_id=${botId} AND ti.user_id=c.user_id
					WHERE (${excludedUserId}::uuid IS NULL OR c.user_id<>${excludedUserId}::uuid)
					ORDER BY c.role_order, c.user_id
				`.pipe(
					Effect.flatMap((rows) =>
						Effect.try({
							try: () => rows.map(decodePetRecipient),
							catch: (cause) =>
								new NotificationRecipientsError({
									message: 'Malformed Telegram recipient row',
									cause,
								}),
						}),
					),
					Effect.mapError((cause) =>
						cause instanceof NotificationRecipientsError
							? cause
							: new NotificationRecipientsError({
									message: 'Recipient lookup failed',
									cause,
								}),
					),
				);
			},
		} satisfies NotificationRecipientsService;
		return service;
	}),
);

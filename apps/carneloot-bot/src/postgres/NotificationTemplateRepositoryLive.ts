import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { TelegramChatId, UserId } from '../domain/Ids.js';
import { owner, subscriber } from '../domain/notifications/RecipientRole.js';
import { NotificationTemplateRepository } from '../ports/NotificationTemplateRepository.js';

const Row = Schema.Struct({
	user_id: UserId,
	private_chat_id: Schema.NullOr(
		Schema.Union([Schema.String, Schema.Number, Schema.BigInt]),
	),
});
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError(
			() =>
				new DomainPersistenceError({
					reason: 'PersistenceFailure',
					message: 'Notification template persistence failed',
				}),
		),
	);
export const layer = Layer.effect(
	NotificationTemplateRepository,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		return NotificationTemplateRepository.of({
			find: Effect.fn('NotificationTemplateRepository.find')(
				function* (botId, ownerId, keyword) {
					return yield* protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const templates =
									yield* sql`SELECT id,message FROM carneloot.notification_templates WHERE owner_user_id=${ownerId}::uuid AND keyword=${keyword} FOR SHARE`;
								if (templates[0] === undefined) return undefined;
								const template = yield* Schema.decodeUnknownEffect(
									Schema.Struct({ id: Schema.String, message: Schema.String }),
								)(templates[0]);
								const rows = yield* sql`
					SELECT c.user_id,ti.private_chat_id FROM (
						SELECT ${ownerId}::uuid AS user_id UNION
						SELECT user_id FROM carneloot.notification_subscriptions WHERE template_id=${template.id}::uuid
					) c LEFT JOIN carneloot.telegram_identities ti ON ti.user_id=c.user_id AND ti.bot_id=${botId}
					ORDER BY c.user_id`;
								const recipients = yield* Effect.forEach(
									rows,
									Effect.fnUntraced(function* (raw) {
										const row = yield* Schema.decodeUnknownEffect(Row)(raw);
										const base = {
											recipientUserId: row.user_id,
											recipientRole:
												row.user_id === ownerId ? owner : subscriber,
											channel: 'telegram',
										};
										if (row.private_chat_id === null)
											return {
												...base,
												_tag: 'Unreachable' as const,
												error: {
													code: 'MissingTelegramIdentity',
													message:
														'Recipient has no Telegram identity for this bot',
												},
											};
										return {
											...base,
											_tag: 'Reachable' as const,
											recipientChatId: yield* Schema.decodeUnknownEffect(
												TelegramChatId,
											)(Number(row.private_chat_id)),
										};
									}),
								);
								return { ...template, recipients };
							}),
						),
					);
				},
			),
		});
	}),
);

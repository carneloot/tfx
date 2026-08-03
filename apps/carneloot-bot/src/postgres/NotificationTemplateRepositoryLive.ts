import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { traceService } from 'tfx/TraceService';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { UserId } from '../domain/Ids.js';
import {
	NotificationKeyword,
	NotificationTemplate,
} from '../domain/notifications/NotificationTemplate.js';
import {
	NotificationTemplateRepository,
	type NotificationTemplateRepositoryService,
} from '../ports/NotificationTemplateRepository.js';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
const Row = Schema.Struct({
	id: Schema.String,
	owner_user_id: UserId,
	keyword: NotificationKeyword,
	message: Schema.String,
	created_at: Timestamp,
	updated_at: Timestamp,
	subscriber_user_id: Schema.NullOr(UserId),
});
const persistence = (cause: unknown) =>
	cause instanceof DomainPersistenceError
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'Notification template repository failed',
				cause,
			});

export const layer = Layer.effect(
	NotificationTemplateRepository,
	Effect.map(PgClient.PgClient, (sql) => {
		const service = {
			findByOwnerAndKeyword: (ownerUserId, keyword) =>
				sql<Record<string, unknown>>`
					SELECT t.id,t.owner_user_id,t.keyword,t.message,t.created_at,t.updated_at,s.user_id AS subscriber_user_id
					FROM carneloot.notification_templates t
					LEFT JOIN carneloot.notification_subscriptions s ON s.template_id=t.id
					WHERE t.owner_user_id=${ownerUserId}::uuid AND t.keyword=${keyword}
					ORDER BY s.user_id
				`.pipe(
					Effect.flatMap((rows) =>
						Effect.try({
							try: () => {
								const first = rows[0];
								if (first === undefined) return undefined;
								const decoded = rows.map((row) =>
									Schema.decodeUnknownSync(Row)(row),
								);
								const template = Schema.decodeUnknownSync(NotificationTemplate)({
									id: decoded[0]?.id,
									ownerUserId: decoded[0]?.owner_user_id,
									keyword: decoded[0]?.keyword,
									message: decoded[0]?.message,
									createdAt: decoded[0]?.created_at,
									updatedAt: decoded[0]?.updated_at,
								});
								return {
									template,
									subscriberUserIds: decoded.flatMap((row) =>
										row.subscriber_user_id === null ? [] : [row.subscriber_user_id],
									),
								};
							},
							catch: (cause) =>
								new DomainPersistenceError({
									reason: 'InvariantViolation',
									message: 'Malformed notification template row',
									cause,
								}),
						}),
					),
					Effect.mapError(persistence),
				),
		} satisfies NotificationTemplateRepositoryService;
		return traceService('NotificationTemplateRepository', service);
	}),
);

import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import {
	ConversationStorage,
	ConversationStorageError,
	type ConversationRow,
	type ConversationStorageService,
	type Mutation,
	type Scope,
} from 'tfx/ConversationStorage';
import { traceService } from 'tfx/TraceService';

import {
	decode,
	expectOne,
	NonNegativeRawInteger,
	NullableInteger,
	NullableTimestamp,
	RawInteger,
	safeCause,
	Uuid,
} from './internal/RowValidation.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';

const RowSchema = Schema.Struct({
	bot_id: Schema.NonEmptyString,
	chat_id: RawInteger,
	user_id: RawInteger,
	instance_id: Uuid,
	origin_trace_id: Schema.NullOr(Schema.String),
	origin_span_id: Schema.NullOr(Schema.String),
	origin_span_sampled: Schema.NullOr(Schema.Boolean),
	conversation_id: Schema.NonEmptyString,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	step: Schema.NonEmptyString,
	state_json: Schema.Unknown,
	revision: NonNegativeRawInteger,
	last_update_id: NullableInteger,
	expires_at: NullableTimestamp,
});
const invariant = (message: string, cause?: unknown) =>
	new ConversationStorageError(
		'InvariantViolation',
		message,
		cause === undefined ? undefined : safeCause(cause),
	);
const persistence = (cause: unknown) =>
	cause instanceof ConversationStorageError
		? cause
		: new ConversationStorageError(
				'PersistenceFailure',
				'PostgreSQL conversation operation failed',
				safeCause(cause),
			);
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(persistence));
class HandlerFailure<E> {
	readonly _tag = 'HandlerFailure';
	constructor(readonly error: E) {}
}
const unwrapHandlerFailure = <A, E, R>(
	effect: Effect.Effect<A, ConversationStorageError | HandlerFailure<E>, R>,
): Effect.Effect<A, ConversationStorageError | E, R> =>
	effect.pipe(
		Effect.catchIf(
			(cause): cause is HandlerFailure<E> => cause instanceof HandlerFailure,
			(cause) => Effect.fail(cause.error),
		),
	);
const validateScope = (scope: Scope) => {
	if (
		!Number.isSafeInteger(scope.chatId) ||
		!Number.isSafeInteger(scope.userId)
	)
		return Effect.fail(invariant('Conversation scope identifiers are unsafe'));
	return Effect.succeed(scope);
};
const decodeRow = (
	raw: unknown,
): Effect.Effect<ConversationRow, ConversationStorageError> =>
	Effect.gen(function* () {
		const row = yield* decode(RowSchema, raw, (cause) =>
			invariant('Malformed conversation row', cause),
		);
		const chatId = row.chat_id;
		const userId = row.user_id;
		const revision = row.revision;
		const lastUpdateId =
			row.last_update_id === null ? undefined : row.last_update_id;
		const expiresAt = row.expires_at === null ? undefined : row.expires_at;
		const originTrace =
			row.origin_trace_id === null ||
			row.origin_span_id === null ||
			row.origin_span_sampled === null
				? undefined
				: {
						traceId: row.origin_trace_id,
						spanId: row.origin_span_id,
						sampled: row.origin_span_sampled,
					};

		return {
			scope: { botId: row.bot_id, chatId, userId },
			instanceId: row.instance_id,
			originTrace,
			conversationId: row.conversation_id,
			version: row.version,
			step: row.step,
			state: row.state_json,
			revision,
			lastUpdateId,
			expiresAt,
		};
	});

export const layer = (
	options: Options = {},
): Layer.Layer<
	ConversationStorage,
	ConversationStorageError,
	PgClient.PgClient
> =>
	Layer.effect(
		ConversationStorage,
		Effect.map(PgClient.PgClient, (sql) => {
			const tables = make(options);
			const schema = sql(tables.schema);
			const table = sql(tables.conversations);
			const select = (scope: Scope, lock = false) =>
				lock
					? sql<
							Record<string, unknown>
						>`SELECT * FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} FOR UPDATE`
					: sql<
							Record<string, unknown>
						>`SELECT * FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId}`;
			const transition: ConversationStorageService['transition'] = (
				scope,
				updateId,
				expectedRevision,
				handler,
				expectedInstanceId,
			) =>
				unwrapHandlerFailure(
					sql
						.withTransaction(
							Effect.gen(function* () {
								yield* validateScope(scope);
								if (!Number.isSafeInteger(updateId))
									return yield* Effect.fail(
										invariant('Unsafe update identifier'),
									);
								const raw = (yield* select(scope, true))[0];
								if (raw === undefined) return { _tag: 'Missing' as const };
								const current = yield* decodeRow(raw);
								if (current.lastUpdateId === updateId)
									return { _tag: 'Duplicate' as const, row: current };
								if (
									current.revision !== expectedRevision ||
									(expectedInstanceId !== undefined &&
										current.instanceId !== expectedInstanceId)
								)
									return { _tag: 'Stale' as const, row: current };
								const now = yield* DateTime.now;
								if (
									current.expiresAt !== undefined &&
									DateTime.isLessThanOrEqualTo(current.expiresAt, now)
								) {
									yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId}`;
									return { _tag: 'Expired' as const };
								}
								const decision = yield* handler(current).pipe(
									Effect.mapError((error) => new HandlerFailure(error)),
								);
								const mutation: Mutation = decision.mutation;
								if (mutation._tag === 'Delete') {
									yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId}`;
									return {
										_tag: 'Applied' as const,
										value: decision.value,
										row: undefined,
										...(mutation.afterCommit === undefined
											? {}
											: { afterCommit: mutation.afterCommit }),
									};
								}
								const rows = yield* sql<
									Record<string, unknown>
								>`UPDATE ${schema}.${table} SET step=${mutation.step}, state_json=${sql.json(mutation.state)}, version=${mutation.version ?? current.version}, revision=revision+1, last_update_id=${updateId}, expires_at=${mutation.expiresAt === undefined ? null : DateTime.toDateUtc(mutation.expiresAt)}, updated_at=now() WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} RETURNING *`;
								const rawUpdated = yield* expectOne(rows, () =>
									invariant('Conversation update returned no row'),
								);
								const updated = yield* decodeRow(rawUpdated);
								return {
									_tag: 'Applied' as const,
									value: decision.value,
									row: updated,
									...(mutation.afterCommit === undefined
										? {}
										: { afterCommit: mutation.afterCommit }),
								};
							}),
						)
						.pipe(
							Effect.mapError((cause) =>
								cause instanceof HandlerFailure ? cause : persistence(cause),
							),
						),
				);
			const service = {
				load: (scope) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								yield* validateScope(scope);
								const now = yield* DateTime.now;
								yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} AND expires_at IS NOT NULL AND expires_at<=${DateTime.toDateUtc(now)}`;
								const raw = (yield* select(scope))[0];
								return raw === undefined ? undefined : yield* decodeRow(raw);
							}),
						),
					),
				create: (row, conflict) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								yield* validateScope(row.scope);
								const now = yield* DateTime.now;
								yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${row.scope.botId} AND chat_id=${row.scope.chatId} AND user_id=${row.scope.userId} AND expires_at IS NOT NULL AND expires_at<=${DateTime.toDateUtc(now)}`;
								const rows =
									conflict === 'fail'
										? yield* sql<
												Record<string, unknown>
											>`INSERT INTO ${schema}.${table} (bot_id,chat_id,user_id,conversation_id,version,step,state_json,revision,last_update_id,expires_at,origin_trace_id,origin_span_id,origin_span_sampled) VALUES (${row.scope.botId},${row.scope.chatId},${row.scope.userId},${row.conversationId},${row.version},${row.step},${sql.json(row.state)},0,${row.lastUpdateId ?? null},${row.expiresAt === undefined ? null : DateTime.toDateUtc(row.expiresAt)},${row.originTrace?.traceId ?? null},${row.originTrace?.spanId ?? null},${row.originTrace?.sampled ?? null}) ON CONFLICT (bot_id,chat_id,user_id) DO NOTHING RETURNING *`
										: yield* sql<
												Record<string, unknown>
											>`INSERT INTO ${schema}.${table} (bot_id,chat_id,user_id,conversation_id,version,step,state_json,revision,last_update_id,expires_at,origin_trace_id,origin_span_id,origin_span_sampled) VALUES (${row.scope.botId},${row.scope.chatId},${row.scope.userId},${row.conversationId},${row.version},${row.step},${sql.json(row.state)},0,${row.lastUpdateId ?? null},${row.expiresAt === undefined ? null : DateTime.toDateUtc(row.expiresAt)},${row.originTrace?.traceId ?? null},${row.originTrace?.spanId ?? null},${row.originTrace?.sampled ?? null}) ON CONFLICT (bot_id,chat_id,user_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,origin_trace_id=EXCLUDED.origin_trace_id,origin_span_id=EXCLUDED.origin_span_id,origin_span_sampled=EXCLUDED.origin_span_sampled,conversation_id=EXCLUDED.conversation_id,version=EXCLUDED.version,step=EXCLUDED.step,state_json=EXCLUDED.state_json,revision=0,last_update_id=EXCLUDED.last_update_id,expires_at=EXCLUDED.expires_at,updated_at=now() RETURNING *`;
								if (rows.length === 0)
									return yield* Effect.fail(
										new ConversationStorageError(
											'Conflict',
											'Conversation already active',
										),
									);
								return yield* decodeRow(
									yield* expectOne(rows, () =>
										invariant('Conversation insert returned invalid row count'),
									),
								);
							}),
						),
					),
				transition,
				cancel: (scope) =>
					protect(
						Effect.gen(function* () {
							yield* validateScope(scope);
							const rows =
								yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} RETURNING bot_id`;
							return rows.length > 0;
						}),
					),
			} satisfies ConversationStorageService;
			return traceService('PostgresConversationStorage', service);
		}),
	);

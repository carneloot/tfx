import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
	ConversationStorage,
	ConversationStorageError,
	type ConversationRow,
	type ConversationStorageService,
	type Mutation,
	type Scope,
} from 'tfx/ConversationStorage';

import { migrate } from './internal/Migrator.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';
type Row = {
	bot_id: string;
	chat_id: string | number;
	user_id: string | number;
	conversation_id: string;
	version: number;
	step: string;
	state_json: unknown;
	revision: string | number;
	last_update_id: string | number | null;
	expires_at: Date | string | null;
};
const decode = (row: Row): ConversationRow => ({
	scope: {
		botId: row.bot_id,
		chatId: Number(row.chat_id),
		userId: Number(row.user_id),
	},
	conversationId: row.conversation_id,
	version: row.version,
	step: row.step,
	state: row.state_json,
	revision: Number(row.revision),
	lastUpdateId:
		row.last_update_id === null ? undefined : Number(row.last_update_id),
	expiresAt:
		row.expires_at === null ? undefined : new Date(row.expires_at).getTime(),
});
export const layer = (
	options: Options = {},
	skipMigration = false,
): Layer.Layer<ConversationStorage, unknown, PgClient.PgClient> =>
	Layer.effect(
		ConversationStorage,
		Effect.andThen(
			skipMigration ? Effect.void : migrate(options),
			Effect.map(PgClient.PgClient, (sql) => {
				const tables = make(options);
				const schema = sql(tables.schema);
				const table = sql(tables.conversations);
				const select = (scope: ConversationRow['scope'], lock = false) =>
					lock
						? sql<Row>`SELECT * FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} FOR UPDATE`
						: sql<Row>`SELECT * FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId}`;
				const service: any = {
					load: (scope: Parameters<ConversationStorageService['load']>[0]) =>
						Effect.map(select(scope), (rows) =>
							rows[0] === undefined ? undefined : decode(rows[0]),
						),
					create: (
						row: Parameters<ConversationStorageService['create']>[0],
						conflict: Parameters<ConversationStorageService['create']>[1],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const existing = (yield* select(row.scope, true))[0];
								if (existing !== undefined && conflict === 'fail')
									return yield* Effect.fail(
										new ConversationStorageError(
											'Conflict',
											'Conversation already active',
										),
									);
								if (existing !== undefined)
									yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${row.scope.botId} AND chat_id=${row.scope.chatId} AND user_id=${row.scope.userId}`;
								const rows =
									yield* sql<Row>`INSERT INTO ${schema}.${table} (bot_id,chat_id,user_id,conversation_id,version,step,state_json,revision,last_update_id,expires_at) VALUES (${row.scope.botId},${row.scope.chatId},${row.scope.userId},${row.conversationId},${row.version},${row.step},${sql.json(row.state)},0,${row.lastUpdateId ?? null},${row.expiresAt === undefined ? null : new Date(row.expiresAt)}) RETURNING *`;
								return decode(rows[0]!);
							}),
						),
					transition: <A, E, R>(
						scope: Scope,
						updateId: number,
						expectedRevision: number,
						handler: (
							row: ConversationRow,
						) => Effect.Effect<
							{ readonly value: A; readonly mutation: Mutation },
							E,
							R
						>,
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const raw = (yield* select(scope, true))[0];
								if (raw === undefined) return { _tag: 'Missing' as const };
								const current = decode(raw);
								if (current.lastUpdateId === updateId)
									return { _tag: 'Duplicate' as const, row: current };
								if (current.revision !== expectedRevision)
									return { _tag: 'Stale' as const, row: current };
								const now = yield* Clock.currentTimeMillis;
								if (
									current.expiresAt !== undefined &&
									current.expiresAt <= now
								) {
									yield* sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId}`;
									return { _tag: 'Expired' as const };
								}
								const decision = yield* handler(current);
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
								const rows =
									yield* sql<Row>`UPDATE ${schema}.${table} SET step=${mutation.step}, state_json=${sql.json(mutation.state)}, version=${mutation.version ?? current.version}, revision=revision+1, last_update_id=${updateId}, expires_at=${mutation.expiresAt === undefined ? null : new Date(mutation.expiresAt)}, updated_at=now() WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} RETURNING *`;
								return {
									_tag: 'Applied' as const,
									value: decision.value,
									row: decode(rows[0]!),
									...(mutation.afterCommit === undefined
										? {}
										: { afterCommit: mutation.afterCommit }),
								};
							}),
						),
					cancel: (
						scope: Parameters<ConversationStorageService['cancel']>[0],
					) =>
						Effect.map(
							sql`DELETE FROM ${schema}.${table} WHERE bot_id=${scope.botId} AND chat_id=${scope.chatId} AND user_id=${scope.userId} RETURNING bot_id`,
							(rows) => rows.length > 0,
						),
				};
				return service as unknown as ConversationStorageService;
			}),
		),
	);

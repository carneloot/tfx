import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { CompletedOutcome } from 'tfx/DispatchOutcome';
import {
	UpdateDeduplicator,
	type ObservedCompletion,
	type UpdateDeduplicatorService,
} from 'tfx/UpdateDeduplicator';

import { migrate } from './internal/Migrator.js';
import { make } from './internal/Tables.js';
import { defaults, type Options } from './Options.js';
type Row = {
	bot_id: string;
	update_id: string | number;
	status: 'processing' | 'completed' | 'released';
	lease_generation: string | number;
	lease_expires_at: Date | string;
	outcome_json: CompletedOutcome | null;
	completed_at: Date | string | null;
};
export const layer = (
	options: Options = {},
): Layer.Layer<UpdateDeduplicator, unknown, PgClient.PgClient> =>
	Layer.effect(
		UpdateDeduplicator,
		Effect.andThen(
			migrate(options),
			Effect.map(PgClient.PgClient, (sql) => {
				const tables = make(options);
				const schema = sql(tables.schema);
				const table = sql(tables.deduplication);
				const botId = options.botId ?? defaults.botId;
				const get = (id: number, lock = false) =>
					lock
						? sql<Row>`SELECT * FROM ${schema}.${table} WHERE bot_id=${botId} AND update_id=${id} FOR UPDATE`
						: sql<Row>`SELECT * FROM ${schema}.${table} WHERE bot_id=${botId} AND update_id=${id}`;
				const service: any = {
					diagnostics: { mode: 'durable', backend: 'postgres' },
					claim: (
						updateId: number,
						claimOptions: {
							readonly leaseDuration?: number;
							readonly waitTimeout?: number;
						} = {},
					) =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const duration = claimOptions.leaseDuration ?? 30_000;
							const wait = claimOptions.waitTimeout ?? 5_000;
							return yield* sql.withTransaction(
								Effect.gen(function* () {
									const current = (yield* get(updateId, true))[0];
									if (current === undefined) {
										yield* sql`INSERT INTO ${schema}.${table} (bot_id,update_id,status,lease_generation,lease_expires_at,attempts,created_at,updated_at) VALUES (${botId},${updateId},'processing',1,${new Date(now + duration)},1,${new Date(now)},${new Date(now)})`;
										return {
											_tag: 'Acquired' as const,
											token: { updateId, generation: 1 },
										};
									}
									if (
										current.status === 'completed' &&
										current.completed_at !== null &&
										new Date(current.completed_at).getTime() + 86_400_000 > now
									)
										return {
											_tag: 'Completed' as const,
											outcome: current.outcome_json!,
										};
									if (
										current.status === 'released' ||
										new Date(current.lease_expires_at).getTime() <= now ||
										current.status === 'completed'
									) {
										const generation = Number(current.lease_generation) + 1;
										yield* sql`UPDATE ${schema}.${table} SET status='processing',lease_generation=${generation},lease_expires_at=${new Date(now + duration)},outcome_json=NULL,completed_at=NULL,attempts=attempts+1,updated_at=${new Date(now)} WHERE bot_id=${botId} AND update_id=${updateId}`;
										return {
											_tag: 'Acquired' as const,
											token: { updateId, generation },
										};
									}
									const started = now;
									const observe: Effect.Effect<ObservedCompletion, unknown> =
										Effect.suspend(() =>
											Effect.flatMap(Clock.currentTimeMillis, (time) => {
												if (time - started >= wait)
													return Effect.succeed({ _tag: 'TimedOut' });
												return Effect.flatMap(get(updateId), (rows) => {
													const row = rows[0];
													if (row === undefined || row.status === 'released')
														return Effect.succeed({ _tag: 'Released' });
													if (row.status === 'completed')
														return Effect.succeed({
															_tag: 'Completed',
															outcome: row.outcome_json!,
														});
													return Effect.andThen(
														Effect.sleep(Math.min(50, wait)),
														observe,
													);
												});
											}),
										);
									return { _tag: 'InProgress' as const, await: observe };
								}),
							);
						}),
					heartbeat: (
						token: Parameters<UpdateDeduplicatorService['heartbeat']>[0],
						duration = 30_000,
					) =>
						Effect.flatMap(Clock.currentTimeMillis, (now) =>
							Effect.map(
								sql`UPDATE ${schema}.${table} SET lease_expires_at=${new Date(now + duration)},updated_at=${new Date(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
								(rows) => rows.length > 0,
							),
						),
					complete: (
						token: Parameters<UpdateDeduplicatorService['complete']>[0],
						outcome: Parameters<UpdateDeduplicatorService['complete']>[1],
						retention = 86_400_000,
					) =>
						Effect.flatMap(Clock.currentTimeMillis, (now) =>
							Effect.map(
								sql`UPDATE ${schema}.${table} SET status='completed',outcome_json=${sql.json(outcome)},completed_at=${new Date(now)},lease_expires_at=${new Date(now + retention)},updated_at=${new Date(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
								(rows) => rows.length > 0,
							),
						),
					release: (
						token: Parameters<UpdateDeduplicatorService['release']>[0],
					) =>
						Effect.flatMap(Clock.currentTimeMillis, (now) =>
							Effect.map(
								sql`UPDATE ${schema}.${table} SET status='released',lease_expires_at=${new Date(now)},updated_at=${new Date(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
								(rows) => rows.length > 0,
							),
						),
				};
				return service as unknown as UpdateDeduplicatorService;
			}),
		),
	);

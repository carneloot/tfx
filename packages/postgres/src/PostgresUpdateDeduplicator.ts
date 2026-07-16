import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type { CompletedOutcome as CompletedOutcomeType } from 'tfx/DispatchOutcome';
import {
	UpdateDeduplicator,
	UpdateDeduplicatorError,
	type ObservedCompletion,
	type UpdateDeduplicatorService,
} from 'tfx/UpdateDeduplicator';

import * as Observer from './internal/DeduplicationObserver.js';
import { migrate } from './internal/Migrator.js';
import {
	CompletedOutcome,
	decode,
	NullableTimestamp,
	NullableUnknown,
	RawInteger,
	Timestamp,
	safeCause,
	safeInteger,
} from './internal/RowValidation.js';
import { make } from './internal/Tables.js';
import { defaults, type Options } from './Options.js';

const RowSchema = Schema.Struct({
	bot_id: Schema.String,
	update_id: RawInteger,
	status: Schema.Literals(['processing', 'completed', 'released']),
	lease_generation: RawInteger,
	lease_expires_at: Timestamp,
	outcome_json: NullableUnknown,
	completed_at: NullableTimestamp,
});
type Row = {
	readonly updateId: number;
	readonly status: 'processing' | 'completed' | 'released';
	readonly generation: number;
	readonly leaseExpiresAt: DateTime.Utc;
	readonly outcome: CompletedOutcomeType | undefined;
	readonly completedAt: DateTime.Utc | undefined;
};
const invariant = (message: string, cause?: unknown) =>
	new UpdateDeduplicatorError(
		'InvariantViolation',
		message,
		cause === undefined ? undefined : safeCause(cause),
	);
const persistence = (cause: unknown) =>
	cause instanceof UpdateDeduplicatorError
		? cause
		: new UpdateDeduplicatorError(
				'PersistenceFailure',
				'PostgreSQL update deduplication operation failed',
				safeCause(cause),
			);
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(persistence));
const decodeRow = (raw: unknown): Effect.Effect<Row, UpdateDeduplicatorError> =>
	Effect.gen(function* () {
		const value = yield* decode(RowSchema, raw, (cause) =>
			invariant('Malformed update deduplication row', cause),
		);
		const updateId = yield* safeInteger(value.update_id, () =>
			invariant('Unsafe deduplication update_id'),
		);
		const generation = yield* safeInteger(value.lease_generation, () =>
			invariant('Unsafe deduplication generation'),
		);
		const leaseExpiresAt = value.lease_expires_at;
		const completedAt =
			value.completed_at === null ? undefined : value.completed_at;
		const outcome =
			value.outcome_json === null
				? undefined
				: yield* decode(CompletedOutcome, value.outcome_json, (cause) =>
						invariant('Malformed completed dispatch outcome', cause),
					);
		if (
			(value.status === 'completed') !==
			(outcome !== undefined && completedAt !== undefined)
		)
			return yield* Effect.fail(
				invariant('Deduplication completion fields violate status invariant'),
			);
		return {
			updateId,
			status: value.status,
			generation,
			leaseExpiresAt,
			outcome,
			completedAt,
		};
	});

export const layer = (
	options: Options = {},
	skipMigration = false,
): Layer.Layer<
	UpdateDeduplicator,
	UpdateDeduplicatorError,
	PgClient.PgClient
> =>
	Layer.effect(
		UpdateDeduplicator,
		Effect.andThen(
			protect(skipMigration ? Effect.void : migrate(options)),
			Effect.map(PgClient.PgClient, (sql) => {
				const tables = make(options);
				const schema = sql(tables.schema);
				const table = sql(tables.deduplication);
				const botId = options.botId ?? defaults.botId;
				const get = (id: number, lock = false) =>
					lock
						? sql<
								Record<string, unknown>
							>`SELECT * FROM ${schema}.${table} WHERE bot_id=${botId} AND update_id=${id} FOR UPDATE`
						: sql<
								Record<string, unknown>
							>`SELECT * FROM ${schema}.${table} WHERE bot_id=${botId} AND update_id=${id}`;
				const read = (id: number, lock = false) =>
					Effect.flatMap(get(id, lock), (rows) =>
						rows[0] === undefined
							? Effect.succeed(undefined)
							: decodeRow(rows[0]),
					);
				const service = {
					diagnostics: { mode: 'durable', backend: 'postgres' },
					claim: (updateId, claimOptions = {}) =>
						protect(
							Effect.gen(function* () {
								if (!Number.isSafeInteger(updateId))
									return yield* Effect.fail(
										invariant('Unsafe update identifier'),
									);
								const now = yield* DateTime.now;
								const duration =
									claimOptions.leaseDuration ?? Duration.seconds(30);
								const wait = claimOptions.waitTimeout ?? Duration.seconds(5);
								return yield* sql.withTransaction(
									Effect.gen(function* () {
										const current = yield* read(updateId, true);
										if (current === undefined) {
											yield* sql`INSERT INTO ${schema}.${table} (bot_id,update_id,status,lease_generation,lease_expires_at,attempts,created_at,updated_at) VALUES (${botId},${updateId},'processing',1,${DateTime.toDateUtc(DateTime.addDuration(now, duration))},1,${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)})`;
											return {
												_tag: 'Acquired' as const,
												token: { updateId, generation: 1 },
											};
										}
										if (
											current.status === 'completed' &&
											DateTime.isGreaterThan(current.leaseExpiresAt, now)
										) {
											if (current.outcome === undefined)
												return yield* Effect.fail(
													invariant('Completed update has no outcome'),
												);
											return {
												_tag: 'Completed' as const,
												outcome: current.outcome,
											};
										}
										if (
											current.status !== 'processing' ||
											DateTime.isLessThanOrEqualTo(current.leaseExpiresAt, now)
										) {
											const generation = current.generation + 1;
											if (!Number.isSafeInteger(generation))
												return yield* Effect.fail(
													invariant('Deduplication generation overflow'),
												);
											yield* sql`UPDATE ${schema}.${table} SET status='processing',lease_generation=${generation},lease_expires_at=${DateTime.toDateUtc(DateTime.addDuration(now, duration))},outcome_json=NULL,completed_at=NULL,attempts=attempts+1,updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND update_id=${updateId}`;
											return {
												_tag: 'Acquired' as const,
												token: { updateId, generation },
											};
										}
										const check: Effect.Effect<
											ObservedCompletion | Observer.Pending,
											UpdateDeduplicatorError
										> = Effect.flatMap(
											protect(read(updateId)),
											(
												row,
											): Effect.Effect<
												ObservedCompletion | Observer.Pending,
												UpdateDeduplicatorError
											> => {
												if (row === undefined || row.status === 'released')
													return Effect.succeed({ _tag: 'Released' as const });
												if (row.status === 'completed') {
													if (row.outcome === undefined)
														return Effect.fail(
															invariant('Completed update has no outcome'),
														);
													return Effect.succeed({
														_tag: 'Completed' as const,
														outcome: row.outcome,
													});
												}
												return Effect.succeed(Observer.pending);
											},
										);
										const observe = Observer.observe({
											startedAt: now,
											waitTimeout: wait,
											check,
										});
										return { _tag: 'InProgress' as const, await: observe };
									}),
								);
							}),
						),
					heartbeat: (token, duration = Duration.seconds(30)) =>
						protect(
							Effect.flatMap(DateTime.now, (now) =>
								Effect.map(
									sql`UPDATE ${schema}.${table} SET lease_expires_at=${DateTime.toDateUtc(DateTime.addDuration(now, duration))},updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
									(rows) => rows.length > 0,
								),
							),
						),
					complete: (token, outcome, retention = Duration.days(1)) =>
						protect(
							Effect.flatMap(DateTime.now, (now) =>
								Effect.map(
									sql`UPDATE ${schema}.${table} SET status='completed',outcome_json=${sql.json(outcome)},completed_at=${DateTime.toDateUtc(now)},lease_expires_at=${DateTime.toDateUtc(DateTime.addDuration(now, retention))},updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
									(rows) => rows.length > 0,
								),
							),
						),
					release: (token) =>
						protect(
							Effect.flatMap(DateTime.now, (now) =>
								Effect.map(
									sql`UPDATE ${schema}.${table} SET status='released',lease_expires_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`,
									(rows) => rows.length > 0,
								),
							),
						),
				} satisfies UpdateDeduplicatorService;
				return service;
			}),
		),
	);

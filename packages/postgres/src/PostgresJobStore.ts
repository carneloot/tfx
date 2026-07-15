import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import {
	JobStore,
	JobStoreError,
	type JobRecord,
	type JobStoreService,
} from 'tfx/JobStore';

import { migrate } from './internal/Migrator.js';
import {
	decode,
	expectOne,
	JobOutcome as JobOutcomeSchema,
	NullableString,
	NullableUnknown,
	RawInteger,
	safeCause,
	safeInteger,
	timestamp,
} from './internal/RowValidation.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';
const RowSchema = Schema.Struct({
	id: Schema.String,
	declaration: Schema.String,
	payload_version: Schema.Number,
	payload_json: Schema.Unknown,
	status: Schema.Literals([
		'scheduled',
		'running',
		'completed',
		'failed',
		'quarantined',
		'cancelled',
	]),
	conflict_key: NullableString,
	attempts: Schema.Number,
	max_attempts: Schema.Number,
	run_at: Schema.Unknown,
	lease_generation: RawInteger,
	lease_phase: Schema.Union([
		Schema.Null,
		Schema.Literals(['migration', 'execution']),
	]),
	lease_expires_at: Schema.Unknown,
	cancellation_requested: Schema.Boolean,
	last_error_json: NullableUnknown,
	outcome_json: NullableUnknown,
	created_at: Schema.Unknown,
	updated_at: Schema.Unknown,
});
const invariant = (message: string, cause?: unknown) =>
	new JobStoreError(
		'InvariantViolation',
		message,
		cause === undefined ? undefined : safeCause(cause),
	);
const persistence = (cause: unknown) =>
	cause instanceof JobStoreError
		? cause
		: new JobStoreError(
				'PersistenceFailure',
				'PostgreSQL job operation failed',
				safeCause(cause),
			);
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(persistence));
const decodeRow = (raw: unknown): Effect.Effect<JobRecord, JobStoreError> =>
	Effect.gen(function* () {
		const row = yield* decode(RowSchema, raw, (cause) =>
			invariant('Malformed job row', cause),
		);
		const leaseGeneration = yield* safeInteger(row.lease_generation, () =>
			invariant('Unsafe job lease generation'),
		);
		const runAt = yield* timestamp(row.run_at, () =>
			invariant('Invalid job run_at'),
		);
		const createdAt = yield* timestamp(row.created_at, () =>
			invariant('Invalid job created_at'),
		);
		const updatedAt = yield* timestamp(row.updated_at, () =>
			invariant('Invalid job updated_at'),
		);
		const leaseExpiresAt =
			row.lease_expires_at === null
				? undefined
				: yield* timestamp(row.lease_expires_at, () =>
						invariant('Invalid job lease expiry'),
					);
		const outcome =
			row.outcome_json === null
				? undefined
				: yield* decode(JobOutcomeSchema, row.outcome_json, (cause) =>
						invariant('Malformed job outcome', cause),
					);
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
				row.id,
			)
		)
			return yield* Effect.fail(invariant('Invalid job UUID'));
		if (row.declaration.length === 0)
			return yield* Effect.fail(invariant('Empty job declaration'));
		if (
			![row.payload_version, row.attempts, row.max_attempts].every(
				Number.isSafeInteger,
			) ||
			row.payload_version <= 0 ||
			row.attempts < 0 ||
			row.max_attempts <= 0 ||
			row.attempts > row.max_attempts
		)
			return yield* Effect.fail(invariant('Invalid job integer fields'));
		if ((row.lease_phase === null) !== (leaseExpiresAt === undefined))
			return yield* Effect.fail(
				invariant('Job lease phase/expiry invariant violated'),
			);
		return {
			id: row.id,
			name: row.declaration,
			payload: row.payload_json,
			payloadVersion: row.payload_version,
			status: row.status,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			runAt,
			...(row.conflict_key === null ? {} : { conflictKey: row.conflict_key }),
			leaseGeneration,
			...(row.lease_phase === null ? {} : { leasePhase: row.lease_phase }),
			...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
			cancellationRequested: row.cancellation_requested,
			...(row.last_error_json === null
				? {}
				: {
						errorSummary:
							typeof row.last_error_json === 'string'
								? row.last_error_json
								: JSON.stringify(row.last_error_json),
					}),
			...(outcome === undefined ? {} : { outcome }),
			createdAt,
			updatedAt,
		};
	});
const decodeOne = (rows: ReadonlyArray<unknown>) =>
	Effect.flatMap(
		expectOne(rows, () =>
			invariant('Job statement returned invalid row count'),
		),
		decodeRow,
	);
export const layer = (
	options: Options = {},
	skipMigration = false,
): Layer.Layer<JobStore, JobStoreError, PgClient.PgClient> =>
	Layer.effect(
		JobStore,
		Effect.andThen(
			protect(skipMigration ? Effect.void : migrate(options)),
			Effect.map(PgClient.PgClient, (sql) => {
				const tables = make(options);
				const schema = sql(tables.schema);
				const jobs = sql(tables.jobs);
				const attempts = sql(tables.jobAttempts);
				const read = (id: string, lock = false) =>
					Effect.flatMap(
						lock
							? sql<
									Record<string, unknown>
								>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid FOR UPDATE`
							: sql<
									Record<string, unknown>
								>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid`,
						(rows) =>
							rows[0] === undefined
								? Effect.succeed(undefined)
								: decodeRow(rows[0]),
					);
				const readToken = (id: string, generation: number, phase: string) =>
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid AND lease_generation=${generation} AND lease_phase=${phase} FOR UPDATE`,
						(rows) =>
							rows[0] === undefined
								? Effect.succeed(undefined)
								: decodeRow(rows[0]),
					);
				const claimDue = (now: number, leaseDuration: number) =>
					Effect.gen(function* () {
						const dueRows = yield* sql<
							Record<string, unknown>
						>`SELECT * FROM ${schema}.${jobs} WHERE status='scheduled' AND run_at<=${new Date(now)} AND (lease_expires_at IS NULL OR lease_expires_at<=${new Date(now)}) ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
						if (dueRows[0] === undefined) return undefined;
						const due = yield* decodeRow(dueRows[0]);
						const rows = yield* sql<
							Record<string, unknown>
						>`UPDATE ${schema}.${jobs} SET lease_phase='migration',lease_generation=lease_generation+1,lease_expires_at=${new Date(now + leaseDuration)},updated_at=${new Date(now)} WHERE id=${due.id}::uuid RETURNING *`;
						const record = yield* decodeOne(rows);
						return {
							record,
							token: { id: record.id, generation: record.leaseGeneration },
						};
					});
				const service = {
					schedule: (request) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									let replacedId: string | undefined;
									if (request.conflictKey !== undefined) {
										yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.name}:${request.conflictKey}`}, 0))`;
										const activeRows = yield* sql<
											Record<string, unknown>
										>`SELECT * FROM ${schema}.${jobs} WHERE declaration=${request.name} AND conflict_key=${request.conflictKey} AND status IN ('scheduled','running') FOR UPDATE`;
										if (activeRows[0] !== undefined) {
											const active = yield* decodeRow(activeRows[0]);
											replacedId = active.id;
											yield* sql`UPDATE ${schema}.${jobs} SET status='cancelled', cancellation_requested=true, lease_phase=NULL, lease_expires_at=NULL, outcome_json=${sql.json({ _tag: 'Cancelled' })}, updated_at=${new Date(request.now)} WHERE id=${replacedId}::uuid`;
										}
									}
									const id = crypto.randomUUID();
									const rows = yield* sql<
										Record<string, unknown>
									>`INSERT INTO ${schema}.${jobs} (id,declaration,payload_version,payload_json,status,conflict_key,attempts,max_attempts,run_at,lease_generation,cancellation_requested,created_at,updated_at) VALUES (${id}::uuid,${request.name},${request.payloadVersion},${sql.json(request.payload)},'scheduled',${request.conflictKey ?? null},0,${request.maxAttempts},${new Date(request.runAt)},0,false,${new Date(request.now)},${new Date(request.now)}) RETURNING *`;
									return {
										record: yield* decodeOne(rows),
										...(replacedId === undefined ? {} : { replacedId }),
									};
								}),
							),
						),
					get: (id) => protect(read(id)),
					claimForMigration: (now, leaseDuration) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									for (let swept = 0; swept < 64; swept++) {
										const expiredRows = yield* sql<
											Record<string, unknown>
										>`SELECT * FROM ${schema}.${jobs} WHERE status='running' AND lease_phase='execution' AND lease_expires_at<=${new Date(now)} ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
										if (expiredRows[0] !== undefined) {
											const expired = yield* decodeRow(expiredRows[0]);
											yield* sql`UPDATE ${schema}.${attempts} SET finished_at=${new Date(now)}, outcome='LeaseLost' WHERE job_id=${expired.id}::uuid AND attempt=${expired.attempts} AND finished_at IS NULL`;
											if (expired.attempts >= expired.maxAttempts) {
												yield* sql`UPDATE ${schema}.${jobs} SET status='failed',lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json({ _tag: 'LeaseLost' })},last_error_json=${sql.json('AttemptsExhausted')},failed_at=${new Date(now)},updated_at=${new Date(now)} WHERE id=${expired.id}::uuid`;
												continue;
											}
											const rows = yield* sql<
												Record<string, unknown>
											>`UPDATE ${schema}.${jobs} SET status='scheduled',lease_phase='migration',lease_generation=lease_generation+1,lease_expires_at=${new Date(now + leaseDuration)},outcome_json=${sql.json({ _tag: 'LeaseLost' })},updated_at=${new Date(now)} WHERE id=${expired.id}::uuid RETURNING *`;
											const record = yield* decodeOne(rows);
											return {
												record,
												token: {
													id: record.id,
													generation: record.leaseGeneration,
												},
											};
										}
										return yield* claimDue(now, leaseDuration);
									}
									return yield* claimDue(now, leaseDuration);
								}),
							),
						),
					promoteToRunning: (claim, payload, version, now, duration) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									const current = yield* readToken(
										claim.id,
										claim.generation,
										'migration',
									);
									if (
										current === undefined ||
										current.leaseExpiresAt === undefined ||
										current.leaseExpiresAt <= now
									)
										return yield* Effect.fail(
											new JobStoreError('StaleToken', 'Migration lease lost'),
										);
									if (current.attempts >= current.maxAttempts)
										return yield* Effect.fail(
											new JobStoreError('InvalidState', 'Attempts exhausted'),
										);
									const next = current.attempts + 1;
									const rows = yield* sql<
										Record<string, unknown>
									>`UPDATE ${schema}.${jobs} SET payload_json=${sql.json(payload)},payload_version=${version},status='running',attempts=${next},lease_phase='execution',lease_expires_at=${new Date(now + duration)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid RETURNING *`;
									yield* sql`INSERT INTO ${schema}.${attempts} (job_id,attempt,lease_generation,started_at) VALUES (${claim.id}::uuid,${next},${claim.generation},${new Date(now)})`;
									return yield* decodeOne(rows);
								}),
							),
						),
					quarantineMigration: (claim, reason, now) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									const current = yield* readToken(
										claim.id,
										claim.generation,
										'migration',
									);
									if (
										current === undefined ||
										current.leaseExpiresAt === undefined ||
										current.leaseExpiresAt <= now
									)
										return yield* Effect.fail(
											new JobStoreError('StaleToken', 'Migration lease lost'),
										);
									const rows = yield* sql<
										Record<string, unknown>
									>`UPDATE ${schema}.${jobs} SET status='quarantined',lease_phase=NULL,lease_expires_at=NULL,last_error_json=${sql.json(reason)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid RETURNING *`;
									return yield* decodeOne(rows);
								}),
							),
						),
					heartbeat: (claim, now, duration) =>
						protect(
							Effect.map(
								sql`UPDATE ${schema}.${jobs} SET lease_expires_at=${new Date(now + duration)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid AND lease_generation=${claim.generation} AND lease_phase='execution' RETURNING id`,
								(rows) => rows.length > 0,
							),
						),
					finalize: (claim, outcome, now, retryAt) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									const current = yield* readToken(
										claim.id,
										claim.generation,
										'execution',
									);
									if (current === undefined) return false;
									const retry =
										outcome._tag === 'RetryableFailure' &&
										retryAt !== undefined &&
										current.attempts < current.maxAttempts;
									const status =
										outcome._tag === 'Succeeded'
											? 'completed'
											: outcome._tag === 'Cancelled'
												? 'cancelled'
												: retry
													? 'scheduled'
													: outcome._tag === 'FatalFailure'
														? 'quarantined'
														: 'failed';
									yield* sql`UPDATE ${schema}.${attempts} SET finished_at=${new Date(now)},outcome=${outcome._tag},error_json=${sql.json(outcome)} WHERE job_id=${claim.id}::uuid AND attempt=${current.attempts}`;
									yield* sql`UPDATE ${schema}.${jobs} SET status=${status},run_at=${retry ? new Date(retryAt) : new Date(current.runAt)},lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json(outcome)},completed_at=${status === 'completed' ? new Date(now) : null},failed_at=${status === 'failed' ? new Date(now) : null},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid`;
									return true;
								}),
							),
						),
					cancel: (id, now) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									const current = yield* read(id, true);
									if (
										current === undefined ||
										(current.status !== 'scheduled' &&
											current.status !== 'running')
									)
										return false;
									if (current.status === 'scheduled')
										yield* sql`UPDATE ${schema}.${jobs} SET status='cancelled',cancellation_requested=true,lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json({ _tag: 'Cancelled' })},updated_at=${new Date(now)} WHERE id=${id}::uuid`;
									else
										yield* sql`UPDATE ${schema}.${jobs} SET cancellation_requested=true,updated_at=${new Date(now)} WHERE id=${id}::uuid`;
									return true;
								}),
							),
						),
					releaseFailed: (id, now, release) =>
						protect(
							sql.withTransaction(
								Effect.gen(function* () {
									const current = yield* read(id, true);
									if (current === undefined)
										return yield* Effect.fail(
											new JobStoreError('NotFound', 'Unknown job'),
										);
									if (
										current.status !== 'failed' &&
										current.status !== 'quarantined'
									)
										return yield* Effect.fail(
											new JobStoreError(
												'InvalidState',
												'Only failed or quarantined jobs can be released',
											),
										);
									const rows = yield* sql<
										Record<string, unknown>
									>`UPDATE ${schema}.${jobs} SET status='scheduled',attempts=${release.resetAttempts ? 0 : current.attempts},run_at=${new Date(now)},last_error_json=${sql.json(release.reason)},outcome_json=NULL,failed_at=NULL,updated_at=${new Date(now)} WHERE id=${id}::uuid RETURNING *`;
									return yield* decodeOne(rows);
								}),
							),
						),
				} satisfies JobStoreService;
				return service;
			}),
		),
	);

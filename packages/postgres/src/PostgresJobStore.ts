import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { JobOutcome } from 'tfx/JobOutcome';
import {
	JobStore,
	JobStoreError,
	type JobRecord,
	type JobStoreService,
} from 'tfx/JobStore';

import { migrate } from './internal/Migrator.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';
type Row = {
	id: string;
	declaration: string;
	payload_version: number;
	payload_json: unknown;
	status: JobRecord['status'];
	conflict_key: string | null;
	attempts: number;
	max_attempts: number;
	run_at: Date | string;
	lease_generation: string | number;
	lease_phase: JobRecord['leasePhase'] | null;
	lease_expires_at: Date | string | null;
	cancellation_requested: boolean;
	last_error_json: unknown | null;
	outcome_json: JobOutcome | null;
	created_at: Date | string;
	updated_at: Date | string;
};
const decode = (row: Row): JobRecord => ({
	id: row.id,
	name: row.declaration,
	payload: row.payload_json,
	payloadVersion: row.payload_version,
	status: row.status,
	attempts: row.attempts,
	maxAttempts: row.max_attempts,
	runAt: new Date(row.run_at).getTime(),
	...(row.conflict_key === null ? {} : { conflictKey: row.conflict_key }),
	leaseGeneration: Number(row.lease_generation),
	...(row.lease_phase === null ? {} : { leasePhase: row.lease_phase }),
	...(row.lease_expires_at === null
		? {}
		: { leaseExpiresAt: new Date(row.lease_expires_at).getTime() }),
	cancellationRequested: row.cancellation_requested,
	...(row.last_error_json === null
		? {}
		: {
				errorSummary:
					typeof row.last_error_json === 'string'
						? row.last_error_json
						: JSON.stringify(row.last_error_json),
			}),
	...(row.outcome_json === null ? {} : { outcome: row.outcome_json }),
	createdAt: new Date(row.created_at).getTime(),
	updatedAt: new Date(row.updated_at).getTime(),
});
export const layer = (
	options: Options = {},
	skipMigration = false,
): Layer.Layer<JobStore, unknown, PgClient.PgClient> =>
	Layer.effect(
		JobStore,
		Effect.andThen(
			skipMigration ? Effect.void : migrate(options),
			Effect.map(PgClient.PgClient, (sql) => {
				const tables = make(options);
				const schema = sql(tables.schema);
				const jobs = sql(tables.jobs);
				const attempts = sql(tables.jobAttempts);
				const get = (id: string, lock = false) =>
					lock
						? sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid FOR UPDATE`
						: sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid`;
				const token = (id: string, generation: number, phase: string) =>
					sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE id=${id}::uuid AND lease_generation=${generation} AND lease_phase=${phase} FOR UPDATE`;
				const service: any = {
					schedule: (request: Parameters<JobStoreService['schedule']>[0]) =>
						sql.withTransaction(
							Effect.gen(function* () {
								let replacedId: string | undefined;
								if (request.conflictKey !== undefined) {
									yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.name}:${request.conflictKey}`}, 0))`;
									const active =
										yield* sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE declaration=${request.name} AND conflict_key=${request.conflictKey} AND status IN ('scheduled','running') FOR UPDATE`;
									if (active[0] !== undefined) {
										replacedId = active[0].id;
										yield* sql`UPDATE ${schema}.${jobs} SET status='cancelled', cancellation_requested=true, lease_phase=NULL, lease_expires_at=NULL, outcome_json=${sql.json({ _tag: 'Cancelled' })}, updated_at=${new Date(request.now)} WHERE id=${replacedId}::uuid`;
									}
								}
								const id = crypto.randomUUID();
								const rows =
									yield* sql<Row>`INSERT INTO ${schema}.${jobs} (id,declaration,payload_version,payload_json,status,conflict_key,attempts,max_attempts,run_at,lease_generation,cancellation_requested,created_at,updated_at) VALUES (${id}::uuid,${request.name},${request.payloadVersion},${sql.json(request.payload)},'scheduled',${request.conflictKey ?? null},0,${request.maxAttempts},${new Date(request.runAt)},0,false,${new Date(request.now)},${new Date(request.now)}) RETURNING *`;
								return {
									record: decode(rows[0]!),
									...(replacedId === undefined ? {} : { replacedId }),
								};
							}),
						),
					get: (id: Parameters<JobStoreService['get']>[0]) =>
						Effect.map(get(id), (rows) =>
							rows[0] === undefined ? undefined : decode(rows[0]),
						),
					claimForMigration: (
						now: Parameters<JobStoreService['claimForMigration']>[0],
						leaseDuration: Parameters<JobStoreService['claimForMigration']>[1],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const expired =
									(yield* sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE status='running' AND lease_phase='execution' AND lease_expires_at<=${new Date(now)} ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
								if (expired !== undefined) {
									yield* sql`UPDATE ${schema}.${attempts} SET finished_at=${new Date(now)}, outcome='LeaseLost' WHERE job_id=${expired.id}::uuid AND attempt=${expired.attempts} AND finished_at IS NULL`;
									if (expired.attempts >= expired.max_attempts) {
										yield* sql`UPDATE ${schema}.${jobs} SET status='failed',lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json({ _tag: 'LeaseLost' })},last_error_json=${sql.json('AttemptsExhausted')},failed_at=${new Date(now)},updated_at=${new Date(now)} WHERE id=${expired.id}::uuid`;
										return undefined;
									}
									const rows =
										yield* sql<Row>`UPDATE ${schema}.${jobs} SET status='scheduled',lease_phase='migration',lease_generation=lease_generation+1,lease_expires_at=${new Date(now + leaseDuration)},outcome_json=${sql.json({ _tag: 'LeaseLost' })},updated_at=${new Date(now)} WHERE id=${expired.id}::uuid RETURNING *`;
									const record = decode(rows[0]!);
									return {
										record,
										token: {
											id: record.id,
											generation: record.leaseGeneration,
										},
									};
								}
								const due =
									(yield* sql<Row>`SELECT * FROM ${schema}.${jobs} WHERE status='scheduled' AND run_at<=${new Date(now)} AND (lease_expires_at IS NULL OR lease_expires_at<=${new Date(now)}) ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
								if (due === undefined) return undefined;
								const rows =
									yield* sql<Row>`UPDATE ${schema}.${jobs} SET lease_phase='migration',lease_generation=lease_generation+1,lease_expires_at=${new Date(now + leaseDuration)},updated_at=${new Date(now)} WHERE id=${due.id}::uuid RETURNING *`;
								const record = decode(rows[0]!);
								return {
									record,
									token: { id: record.id, generation: record.leaseGeneration },
								};
							}),
						),
					promoteToRunning: (
						claim: Parameters<JobStoreService['promoteToRunning']>[0],
						payload: Parameters<JobStoreService['promoteToRunning']>[1],
						version: Parameters<JobStoreService['promoteToRunning']>[2],
						now: Parameters<JobStoreService['promoteToRunning']>[3],
						duration: Parameters<JobStoreService['promoteToRunning']>[4],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const current = (yield* token(
									claim.id,
									claim.generation,
									'migration',
								))[0];
								if (current === undefined)
									return yield* Effect.fail(
										new JobStoreError('StaleToken', 'Migration lease lost'),
									);
								if (current.attempts >= current.max_attempts)
									return yield* Effect.fail(
										new JobStoreError('InvalidState', 'Attempts exhausted'),
									);
								const next = current.attempts + 1;
								const rows =
									yield* sql<Row>`UPDATE ${schema}.${jobs} SET payload_json=${sql.json(payload)},payload_version=${version},status='running',attempts=${next},lease_phase='execution',lease_expires_at=${new Date(now + duration)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid RETURNING *`;
								yield* sql`INSERT INTO ${schema}.${attempts} (job_id,attempt,lease_generation,started_at) VALUES (${claim.id}::uuid,${next},${claim.generation},${new Date(now)})`;
								return decode(rows[0]!);
							}),
						),
					quarantineMigration: (
						claim: Parameters<JobStoreService['quarantineMigration']>[0],
						reason: Parameters<JobStoreService['quarantineMigration']>[1],
						now: Parameters<JobStoreService['quarantineMigration']>[2],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								if (
									(yield* token(claim.id, claim.generation, 'migration'))[0] ===
									undefined
								)
									return yield* Effect.fail(
										new JobStoreError('StaleToken', 'Migration lease lost'),
									);
								const rows =
									yield* sql<Row>`UPDATE ${schema}.${jobs} SET status='quarantined',lease_phase=NULL,lease_expires_at=NULL,last_error_json=${sql.json(reason)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid RETURNING *`;
								return decode(rows[0]!);
							}),
						),
					heartbeat: (
						claim: Parameters<JobStoreService['heartbeat']>[0],
						now: Parameters<JobStoreService['heartbeat']>[1],
						duration: Parameters<JobStoreService['heartbeat']>[2],
					) =>
						Effect.map(
							sql`UPDATE ${schema}.${jobs} SET lease_expires_at=${new Date(now + duration)},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid AND lease_generation=${claim.generation} AND lease_phase='execution' RETURNING id`,
							(rows) => rows.length > 0,
						),
					finalize: (
						claim: Parameters<JobStoreService['finalize']>[0],
						outcome: Parameters<JobStoreService['finalize']>[1],
						now: Parameters<JobStoreService['finalize']>[2],
						retryAt: Parameters<JobStoreService['finalize']>[3],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const current = (yield* token(
									claim.id,
									claim.generation,
									'execution',
								))[0];
								if (current === undefined) return false;
								const retry =
									outcome._tag === 'RetryableFailure' &&
									retryAt !== undefined &&
									current.attempts < current.max_attempts;
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
								yield* sql`UPDATE ${schema}.${jobs} SET status=${status},run_at=${retry ? new Date(retryAt!) : new Date(current.run_at)},lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json(outcome)},completed_at=${status === 'completed' ? new Date(now) : null},failed_at=${status === 'failed' ? new Date(now) : null},updated_at=${new Date(now)} WHERE id=${claim.id}::uuid`;
								return true;
							}),
						),
					cancel: (
						id: Parameters<JobStoreService['cancel']>[0],
						now: Parameters<JobStoreService['cancel']>[1],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const current = (yield* get(id, true))[0];
								if (
									current === undefined ||
									!['scheduled', 'running'].includes(current.status)
								)
									return false;
								if (current.status === 'scheduled')
									yield* sql`UPDATE ${schema}.${jobs} SET status='cancelled',cancellation_requested=true,lease_phase=NULL,lease_expires_at=NULL,outcome_json=${sql.json({ _tag: 'Cancelled' })},updated_at=${new Date(now)} WHERE id=${id}::uuid`;
								else
									yield* sql`UPDATE ${schema}.${jobs} SET cancellation_requested=true,updated_at=${new Date(now)} WHERE id=${id}::uuid`;
								return true;
							}),
						),
					releaseFailed: (
						id: Parameters<JobStoreService['releaseFailed']>[0],
						now: Parameters<JobStoreService['releaseFailed']>[1],
						release: Parameters<JobStoreService['releaseFailed']>[2],
					) =>
						sql.withTransaction(
							Effect.gen(function* () {
								const current = (yield* get(id, true))[0];
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
								const rows =
									yield* sql<Row>`UPDATE ${schema}.${jobs} SET status='scheduled',attempts=${release.resetAttempts ? 0 : current.attempts},run_at=${new Date(now)},last_error_json=${sql.json(release.reason)},outcome_json=NULL,failed_at=NULL,updated_at=${new Date(now)} WHERE id=${id}::uuid RETURNING *`;
								return decode(rows[0]!);
							}),
						),
				};
				return service as unknown as JobStoreService;
			}),
		),
	);

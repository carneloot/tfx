import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { JobStoreError } from 'tfx/JobStore';
import { JobWakeup } from 'tfx/JobWakeup';

import {
	decode,
	NullableTimestamp,
	safeCause,
	Uuid,
} from './internal/RowValidation.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';

const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((cause) =>
			cause instanceof JobStoreError
				? cause
				: new JobStoreError(
						'PersistenceFailure',
						'Job wakeup operation failed',
						safeCause(cause),
					),
		),
	);

const invalidRow = (cause: unknown) =>
	new JobStoreError(
		'InvariantViolation',
		'Malformed job wakeup row',
		safeCause(cause),
	);
const Receipts = Schema.Array(Schema.Struct({ id: Uuid, revision: Uuid }));
const Deadline = Schema.Struct({ deadline: NullableTimestamp });

export const layer = (options: Options = {}) =>
	Layer.effect(
		JobWakeup,
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient;
			const tables = make(options);
			const schema = sql(tables.schema);
			const jobs = sql(tables.jobs);
			const outbox = sql(tables.jobWakeups);
			return {
				snapshot: protect(
					Effect.gen(function* () {
						// Read receipts FIRST. Any change after this read remains unacknowledged.
						const receipts = yield* decode(
							Receipts,
							yield* sql`SELECT id,revision FROM ${schema}.${outbox} LIMIT 1000`,
							invalidRow,
						);
						const rows = yield* sql`SELECT min(deadline) AS deadline FROM (
				SELECT CASE WHEN lease_expires_at IS NULL THEN run_at ELSE greatest(run_at,lease_expires_at) END AS deadline FROM ${schema}.${jobs} WHERE status='scheduled'
				UNION ALL SELECT lease_expires_at FROM ${schema}.${jobs} WHERE status='running'
			) deadlines`;
						const row = yield* decode(Deadline, rows[0], invalidRow);
						return {
							receipts,
							deadline:
								row.deadline === null
									? undefined
									: DateTime.toEpochMillis(row.deadline),
						};
					}),
				),
				acknowledge: (snapshot) =>
					protect(
						sql`DELETE FROM ${schema}.${outbox} o USING jsonb_to_recordset(${sql.json(snapshot.receipts)}) AS r(id uuid, revision uuid) WHERE o.id=r.id AND o.revision=r.revision`.pipe(
							Effect.asVoid,
						),
					),
			} satisfies JobWakeup['Service'];
		}),
	);

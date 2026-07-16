import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Deferred, Duration, Effect, Fiber, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { JobStore } from '../../tfx/src/JobStore.js';
import { jobStoreConformance } from '../../tfx/test/internal/JobStoreConformance.js';
import * as PostgresJobStore from '../src/PostgresJobStore.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapter = PostgresJobStore.layer({
	schema: 'tfx_job_test',
	tablePrefix: 'case_',
});
const layer = () => Layer.provide(adapter, PostgresTestLayer.layer);
const diagnosticLayer = Layer.provideMerge(adapter, PostgresTestLayer.layer);
if (!enabled)
	describe.skip('PostgreSQL job conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else {
	jobStoreConformance('postgres', layer);
	describe('PostgreSQL job claim coordination', () => {
		it('preserves numeric retry duration JSON encoding', async () => {
			const id = crypto.randomUUID();
			const now = DateTime.makeUnsafe('2024-01-02T03:04:05.000Z');
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const store = yield* JobStore;
				const scheduled = yield* store.schedule({
					name: `encoding-${id}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 2,
					runAt: now,
					now,
				});
				const claim = yield* store.claimForMigration(now, Duration.seconds(1));
				if (claim === undefined || claim.record.id !== scheduled.record.id)
					throw new Error('expected scheduled job claim');
				yield* store.promoteToRunning(
					claim.token,
					{},
					1,
					now,
					Duration.seconds(1),
				);
				yield* store.finalize(
					claim.token,
					{
						_tag: 'RetryableFailure',
						error: 'retry',
						retryAfter: Duration.millis(100),
					},
					now,
					DateTime.addDuration(now, Duration.millis(100)),
				);
				const rows = yield* sql<{
					outcome_json: { retryAfter?: unknown };
				}>`SELECT outcome_json FROM tfx_job_test.case_jobs WHERE id=${scheduled.record.id}::uuid`;
				return { record: yield* store.get(scheduled.record.id), rows };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, diagnosticLayer),
			);
			expect(result.rows[0]?.outcome_json.retryAfter).toBe(100);
			if (result.record?.outcome?._tag !== 'RetryableFailure')
				throw new Error('expected retryable outcome');
			expect(Duration.toMillis(result.record.outcome.retryAfter!)).toBe(100);
		});

		it('continues past an exhausted expired execution claim', async () => {
			const program = Effect.gen(function* () {
				const store = yield* JobStore;
				const first = yield* store.schedule({
					name: `expired-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 1,
					runAt: DateTime.makeUnsafe(0),
					now: DateTime.makeUnsafe(0),
				});
				const firstClaim = yield* store.claimForMigration(
					DateTime.makeUnsafe(0),
					Duration.millis(1),
				);
				if (firstClaim === undefined) throw new Error('expected first claim');
				yield* store.promoteToRunning(
					firstClaim.token,
					{},
					1,
					DateTime.makeUnsafe(0),
					Duration.millis(1),
				);
				const second = yield* store.schedule({
					name: `due-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 2,
					runAt: DateTime.makeUnsafe(0),
					now: DateTime.makeUnsafe(0),
				});
				const claim = yield* store.claimForMigration(
					DateTime.makeUnsafe(2),
					Duration.millis(10),
				);
				return { first: yield* store.get(first.record.id), second, claim };
			});
			const result = await Effect.runPromise(Effect.provide(program, layer()));
			expect(result.first?.status).toBe('failed');
			expect(result.claim?.record.id).toBe(result.second.record.id);
		});

		it('rejects unsafe persisted job integers as invariants', async () => {
			const id = crypto.randomUUID();
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const store = yield* JobStore;
				yield* sql`INSERT INTO tfx_job_test.case_jobs (id,declaration,payload_version,payload_json,status,attempts,max_attempts,run_at,lease_generation,cancellation_requested,created_at,updated_at) VALUES (${id}::uuid,'unsafe',1,'{}'::jsonb,'scheduled',0,1,now(),9007199254740992,false,now(),now())`;
				const result = yield* Effect.result(store.get(id));
				yield* sql`DELETE FROM tfx_job_test.case_jobs WHERE id=${id}::uuid`;
				return result;
			});
			const result = await Effect.runPromise(
				Effect.provide(program, diagnosticLayer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { reason: 'InvariantViolation' },
			});
		});

		it('bounds exhausted reclaim before claiming due work', async () => {
			const declaration = `sweep-${crypto.randomUUID()}`;
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const store = yield* JobStore;
				yield* sql`INSERT INTO tfx_job_test.case_jobs (id,declaration,payload_version,payload_json,status,attempts,max_attempts,run_at,lease_generation,lease_phase,lease_expires_at,cancellation_requested,created_at,updated_at) SELECT gen_random_uuid(),${declaration},1,'{}'::jsonb,'running',1,1,to_timestamp(0),1,'execution',to_timestamp(0),false,to_timestamp(0),to_timestamp(0) FROM generate_series(1,65)`;
				const due = yield* store.schedule({
					name: `due-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 2,
					runAt: DateTime.makeUnsafe(0),
					now: DateTime.makeUnsafe(0),
				});
				const claim = yield* store.claimForMigration(
					DateTime.makeUnsafe(2),
					Duration.millis(10),
				);
				yield* sql`DELETE FROM tfx_job_test.case_jobs WHERE declaration=${declaration}`;
				return { due, claim };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, diagnosticLayer),
			);
			expect(result.claim?.record.id).toBe(result.due.record.id);
		});

		it('gives simultaneous claimers distinct jobs', async () => {
			const program = Effect.gen(function* () {
				const store = yield* JobStore;
				for (const suffix of ['a', 'b'])
					yield* store.schedule({
						name: `parallel-${suffix}-${crypto.randomUUID()}`,
						payload: {},
						payloadVersion: 1,
						maxAttempts: 2,
						runAt: DateTime.makeUnsafe(0),
						now: DateTime.makeUnsafe(0),
					});
				const readyA = yield* Deferred.make<void>();
				const readyB = yield* Deferred.make<void>();
				const go = yield* Deferred.make<void>();
				const claim = (ready: Deferred.Deferred<void>) =>
					Effect.andThen(
						Deferred.succeed(ready, undefined),
						Effect.andThen(
							Deferred.await(go),
							store.claimForMigration(
								DateTime.makeUnsafe(0),
								Duration.millis(10),
							),
						),
					);
				const a = yield* Effect.forkChild(claim(readyA));
				const b = yield* Effect.forkChild(claim(readyB));
				yield* Deferred.await(readyA);
				yield* Deferred.await(readyB);
				yield* Deferred.succeed(go, undefined);
				return yield* Effect.all([Fiber.join(a), Fiber.join(b)], {
					concurrency: 'unbounded',
				});
			});
			const claims = await Effect.runPromise(Effect.provide(program, layer()));
			expect(new Set(claims.map((claim) => claim?.record.id)).size).toBe(2);
		});

		it('enforces persisted status, lease, and outcome combinations', async () => {
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const store = yield* JobStore;
				const scheduled = yield* store.schedule({
					name: `state-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 2,
					runAt: DateTime.makeUnsafe(0),
					now: DateTime.makeUnsafe(0),
				});
				const id = scheduled.record.id;
				const invalid = [
					sql`UPDATE tfx_job_test.case_jobs SET status='running',lease_phase=NULL,lease_expires_at=NULL,outcome_json=NULL WHERE id=${id}::uuid`,
					sql`UPDATE tfx_job_test.case_jobs SET status='completed',lease_phase='execution',lease_expires_at=now() + interval '1 minute',outcome_json='{"_tag":"Succeeded"}'::jsonb WHERE id=${id}::uuid`,
					sql`UPDATE tfx_job_test.case_jobs SET status='completed',lease_phase=NULL,lease_expires_at=NULL,outcome_json=NULL WHERE id=${id}::uuid`,
				];
				const results = yield* Effect.forEach(invalid, Effect.result);
				yield* sql`DELETE FROM tfx_job_test.case_jobs WHERE id=${id}::uuid`;
				return results;
			});
			const results = await Effect.runPromise(
				Effect.provide(program, diagnosticLayer),
			);
			expect(results.every((result) => result._tag === 'Failure')).toBe(true);
		});
	});
}

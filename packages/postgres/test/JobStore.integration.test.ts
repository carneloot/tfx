import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Deferred, Duration, Effect, Fiber, Layer } from 'effect';
import { JobWakeup } from 'tfx/JobWakeup';
import { describe, expect, it } from 'vitest';

import { JobStore } from '../../tfx/src/JobStore.js';
import { jobStoreConformance } from '../../tfx/test/internal/JobStoreConformance.js';
import { migrate } from '../src/Migrations.js';
import * as PostgresJobStore from '../src/PostgresJobStore.js';
import * as PostgresJobWakeup from '../src/PostgresJobWakeup.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const options = {
	schema: 'tfx_job_test',
	tablePrefix: 'case_',
};
const adapter = Layer.unwrap(
	Effect.as(
		migrate(options),
		Layer.merge(
			PostgresJobStore.layer(options),
			PostgresJobWakeup.layer(options),
		),
	),
);
const layer = () => Layer.provide(adapter, PostgresTestLayer.layer);
const diagnosticLayer = Layer.provideMerge(adapter, PostgresTestLayer.layer);
if (!enabled)
	describe.skip('PostgreSQL job conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else {
	jobStoreConformance('postgres', layer);
	describe('PostgreSQL job claim coordination', () => {
		it('commits wakeup intents atomically and fences acknowledgements against later changes', async () => {
			const program = Effect.gen(function* () {
				const store = yield* JobStore;
				const wakeup = yield* JobWakeup;
				const sql = yield* PgClient.PgClient;
				const now = DateTime.makeUnsafe(1000);
				const request = {
					name: 'outbox',
					payload: {},
					payloadVersion: 1,
					maxAttempts: 3,
					now,
					runAt: now,
					conflictKey: 'shared-pet',
				};
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* store.schedule(request);
							return yield* Effect.fail('rollback');
						}),
					)
					.pipe(Effect.ignore);
				expect(yield* wakeup.snapshot).toEqual({
					receipts: [],
					deadline: undefined,
				});
				const first = yield* store.schedule(request);
				const committed = yield* wakeup.snapshot;
				expect(committed.deadline).toBe(1000);
				expect(committed.receipts.map((r) => r.id)).toEqual([first.record.id]);
				// SQL commit with no native handoff leaves a recoverable intent.
				expect(yield* wakeup.snapshot).toEqual(committed);
				const replacement = yield* store.schedule({
					...request,
					runAt: DateTime.makeUnsafe(8000),
				});
				yield* wakeup.acknowledge(committed);
				const changed = yield* wakeup.snapshot;
				expect(changed.deadline).toBe(8000);
				expect(new Set(changed.receipts.map((r) => r.id))).toEqual(
					new Set([first.record.id, replacement.record.id]),
				);
				yield* store.cancel(replacement.record.id, now);
				yield* wakeup.acknowledge(changed);
				const cancelled = yield* wakeup.snapshot;
				expect(cancelled.deadline).toBeUndefined();
				expect(cancelled.receipts.map((r) => r.id)).toEqual([
					replacement.record.id,
				]);
				yield* wakeup.acknowledge(cancelled);
				expect(yield* wakeup.snapshot).toEqual({
					receipts: [],
					deadline: undefined,
				});
			});
			await Effect.runPromise(Effect.provide(program, diagnosticLayer));
		});

		it('wakes at migration and execution lease expiry, then at a retry deadline', async () => {
			const program = Effect.gen(function* () {
				const store = yield* JobStore;
				const wakeup = yield* JobWakeup;
				const now = DateTime.makeUnsafe(1000);
				yield* store.schedule({
					name: 'leases',
					payload: {},
					payloadVersion: 1,
					maxAttempts: 3,
					now,
					runAt: now,
				});
				const claim = yield* store.claimForMigration(now, Duration.millis(400));
				if (claim === undefined) throw new Error('Expected a claim');
				expect((yield* wakeup.snapshot).deadline).toBe(1400);
				yield* store.promoteToRunning(
					claim.token,
					{},
					1,
					DateTime.makeUnsafe(1100),
					Duration.millis(700),
				);
				expect((yield* wakeup.snapshot).deadline).toBe(1800);
				yield* store.finalize(
					claim.token,
					{
						_tag: 'RetryableFailure',
						error: 'retry',
						retryAfter: Duration.millis(2000),
					},
					DateTime.makeUnsafe(1200),
					DateTime.makeUnsafe(3200),
				);
				expect((yield* wakeup.snapshot).deadline).toBe(3200);
			});
			await Effect.runPromise(Effect.provide(program, diagnosticLayer));
		});

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

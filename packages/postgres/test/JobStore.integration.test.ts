import * as PgClient from '@effect/sql-pg/PgClient';
import { Deferred, Effect, Fiber, Layer } from 'effect';
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
		it('continues past an exhausted expired execution claim', async () => {
			const program = Effect.gen(function* () {
				const store = yield* JobStore;
				const first = yield* store.schedule({
					name: `expired-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 1,
					runAt: 0,
					now: 0,
				});
				const firstClaim = yield* store.claimForMigration(0, 1);
				if (firstClaim === undefined) throw new Error('expected first claim');
				yield* store.promoteToRunning(firstClaim.token, {}, 1, 0, 1);
				const second = yield* store.schedule({
					name: `due-${crypto.randomUUID()}`,
					payload: {},
					payloadVersion: 1,
					maxAttempts: 2,
					runAt: 0,
					now: 0,
				});
				const claim = yield* store.claimForMigration(2, 10);
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
					runAt: 0,
					now: 0,
				});
				const claim = yield* store.claimForMigration(2, 10);
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
						runAt: 0,
						now: 0,
					});
				const readyA = yield* Deferred.make<void>();
				const readyB = yield* Deferred.make<void>();
				const go = yield* Deferred.make<void>();
				const claim = (ready: Deferred.Deferred<void>) =>
					Effect.andThen(
						Deferred.succeed(ready, undefined),
						Effect.andThen(Deferred.await(go), store.claimForMigration(0, 10)),
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
	});
}

import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { JobStore } from '../../tfx/src/JobStore.js';
import { jobStoreConformance } from '../../tfx/test/internal/JobStoreConformance.js';
import * as PostgresJobStore from '../src/PostgresJobStore.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = () =>
	Layer.provide(
		PostgresJobStore.layer({
			schema: 'tfx_job_test',
			tablePrefix: 'case_',
		}),
		PostgresTestLayer.layer,
	);
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
				return yield* Effect.all(
					[store.claimForMigration(0, 10), store.claimForMigration(0, 10)],
					{ concurrency: 'unbounded' },
				);
			});
			const claims = await Effect.runPromise(Effect.provide(program, layer()));
			expect(new Set(claims.map((claim) => claim?.record.id)).size).toBe(2);
		});
	});
}

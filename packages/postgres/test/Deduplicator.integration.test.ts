import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { UpdateDeduplicator } from '../../tfx/src/UpdateDeduplicator.js';
import { deduplicatorConformance } from '../../tfx/test/internal/DeduplicatorConformance.js';
import * as PostgresUpdateDeduplicator from '../src/PostgresUpdateDeduplicator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const adapter = PostgresUpdateDeduplicator.layer({
	schema: 'tfx_dedup_test',
	tablePrefix: 'case_',
});
const layer = () => Layer.provide(adapter, PostgresTestLayer.layer);
const diagnosticLayer = Layer.provideMerge(adapter, PostgresTestLayer.layer);
if (!enabled)
	describe.skip('PostgreSQL dedup conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else {
	deduplicatorConformance('postgres', layer);
	describe('PostgreSQL dedup coordination', () => {
		it('fences simultaneous claims', async () => {
			const updateId = Math.floor(Math.random() * 1_000_000_000);
			const program = Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				return yield* Effect.all(
					[dedup.claim(updateId), dedup.claim(updateId)],
					{
						concurrency: 'unbounded',
					},
				);
			});
			const claims = await Effect.runPromise(Effect.provide(program, layer()));
			expect(claims.filter((claim) => claim._tag === 'Acquired')).toHaveLength(
				1,
			);
			expect(
				claims.filter((claim) => claim._tag === 'InProgress'),
			).toHaveLength(1);
		});

		it('rejects a completed row with a null outcome as an invariant', async () => {
			const updateId = Math.floor(Math.random() * 1_000_000_000);
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const dedup = yield* UpdateDeduplicator;
				yield* sql`ALTER TABLE tfx_dedup_test.case_update_deduplication DROP CONSTRAINT case_dedup_outcome_chk`;
				yield* sql`INSERT INTO tfx_dedup_test.case_update_deduplication (bot_id,update_id,status,lease_generation,lease_expires_at,outcome_json,attempts,completed_at) VALUES ('bot',${updateId},'completed',1,now() + interval '1 hour',NULL,1,now())`;
				const result = yield* Effect.result(dedup.claim(updateId));
				yield* sql`DELETE FROM tfx_dedup_test.case_update_deduplication WHERE update_id=${updateId}`;
				yield* sql`ALTER TABLE tfx_dedup_test.case_update_deduplication ADD CONSTRAINT case_dedup_outcome_chk CHECK ((status = 'completed' AND outcome_json IS NOT NULL AND completed_at IS NOT NULL) OR (status <> 'completed' AND outcome_json IS NULL AND completed_at IS NULL))`;
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
	});
}

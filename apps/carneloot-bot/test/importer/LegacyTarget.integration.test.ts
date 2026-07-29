import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { MappedLegacy } from '../../src/importer/LegacyMapping.js';
import { LegacyTarget } from '../../src/importer/LegacyTarget.js';
import * as LegacyTargetLive from '../../src/importer/LegacyTargetLive.js';
import { migrate } from '../../src/postgres/AppMigrator.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('legacy target dry run', () => {
	it('returns inserted counts while rolling target and ledger rows back', async () => {
		const id = randomUUID();
		const mapped: MappedLegacy = {
			fingerprint: `dry-run-${id}`,
			rows: [
				{
					sourceTable: 'users',
					sourceKey: '1',
					targetTable: 'users',
					targetKey: id,
					value: {
						id,
						created_at: '2026-01-01T00:00:00.000Z',
						updated_at: '2026-01-01T00:00:00.000Z',
					},
				},
			],
			rounding: [],
			warnings: [],
		};
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				yield* migrate;
				const promotion = yield* target.promote(mapped, { dryRun: true });
				const users = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.users WHERE id=${id}`;
				const ledgers = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint}`;
				return {
					promotion,
					users: users[0]?.count,
					ledgers: ledgers[0]?.count,
				};
			}).pipe(
				Effect.provide(
					Layer.provideMerge(LegacyTargetLive.layer, PostgresTestLayer.layer),
				),
			),
		);
		expect(result.promotion).toEqual({ inserted: { users: 1 }, existing: {} });
		expect(result.users).toBe(0);
		expect(result.ledgers).toBe(0);
	});
});

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import { migrate } from './MigrateTestDatabase.js';
import * as PostgresTestLayer from './PostgresTestLayer.js';
import { reset } from './ResetTestDatabase.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
describe.skipIf(!enabled)('private PostgreSQL test Layer', () => {
	it('starts/migrates/resets a disposable database', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const sql = yield* PgClient.PgClient;
			yield* sql.unsafe("INSERT INTO tfx_test_marker (id) VALUES ('one')");
			yield* reset;
			const rows = yield* sql.unsafe('SELECT * FROM tfx_test_marker');
			return rows;
		});
		await expect(
			Effect.runPromise(Effect.provide(program, PostgresTestLayer.layer)),
		).resolves.toEqual([]);
	});
});

import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { Migration } from '../src/Migration.js';
import { run } from '../src/PostgresMigrator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const checksum = (character: string) => character.repeat(64);
const options = (suffix: string, migrations: ReadonlyArray<Migration>) => ({
	schema: `migrator_${suffix}`,
	table: 'migrations',
	lockKey: `migrator:${suffix}`,
	logPrefix: `test.${suffix}`,
	migrations,
});

describe.skipIf(!enabled)('shared PostgreSQL migrator', () => {
	it('serializes concurrent bootstrap and applies each migration once', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const migrations: ReadonlyArray<Migration> = [
			{
				version: 1,
				name: 'one',
				checksum: checksum('a'),
				up: (sql) =>
					sql`CREATE TABLE ${sql(`migrator_${suffix}`)}.${sql('items')} (id integer PRIMARY KEY)`,
			},
		];
		const program = Effect.gen(function* () {
			yield* Effect.all(
				[run(options(suffix, migrations)), run(options(suffix, migrations))],
				{ concurrency: 'unbounded' },
			);
			const sql = yield* PgClient.PgClient;
			return yield* sql<{
				count: string;
			}>`SELECT count(*)::text AS count FROM ${sql(`migrator_${suffix}`)}.${sql('migrations')}`;
		});
		const rows = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(rows[0]?.count).toBe('1');
	});

	it('rejects unknown future ledger rows and checksum drift', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const migrations: ReadonlyArray<Migration> = [
			{
				version: 1,
				name: 'one',
				checksum: checksum('a'),
				up: () => Effect.void,
			},
		];
		const program = Effect.gen(function* () {
			yield* run(options(suffix, migrations));
			const sql = yield* PgClient.PgClient;
			const schema = sql(`migrator_${suffix}`);
			const table = sql('migrations');
			yield* sql`INSERT INTO ${schema}.${table} (version,name,checksum) VALUES (99,'future',${checksum('f')})`;
			const future = yield* Effect.result(run(options(suffix, migrations)));
			yield* sql`DELETE FROM ${schema}.${table} WHERE version=99`;
			yield* sql`UPDATE ${schema}.${table} SET checksum=${checksum('b')} WHERE version=1`;
			const drift = yield* Effect.result(run(options(suffix, migrations)));
			return { future, drift };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		for (const failure of [result.future, result.drift])
			expect(failure).toMatchObject({
				_tag: 'Failure',
				failure: {
					_tag: 'MigrationError',
					stage: 'ledger_validation',
				},
			});
	});

	it('rolls back failed migration work and its ledger row', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const first: Migration = {
			version: 1,
			name: 'one',
			checksum: checksum('a'),
			up: () => Effect.void,
		};
		const second: Migration = {
			version: 2,
			name: 'two',
			checksum: checksum('b'),
			up: (sql) =>
				Effect.andThen(
					sql`CREATE TABLE ${sql(`migrator_${suffix}`)}.${sql('rolled_back')} (id integer)`,
					Effect.fail('expected failure'),
				),
		};
		const program = Effect.gen(function* () {
			yield* run(options(suffix, [first]));
			const failed = yield* Effect.result(
				run(options(suffix, [first, second])),
			);
			const sql = yield* PgClient.PgClient;
			const ledger = yield* sql<{
				count: string;
			}>`SELECT count(*)::text AS count FROM ${sql(`migrator_${suffix}`)}.${sql('migrations')}`;
			const table = yield* sql<{
				value: string | null;
			}>`SELECT to_regclass(${`migrator_${suffix}.rolled_back`})::text AS value`;
			return { failed, ledger, table };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result.failed).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'MigrationError', stage: 'apply', version: 2 },
		});
		expect(result.ledger[0]?.count).toBe('1');
		expect(result.table[0]?.value).toBeNull();
	});
});

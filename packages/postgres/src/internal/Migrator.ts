import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import type { Options } from '../Options.js';
import { up as up0001 } from './Migration0001.js';
import { up as up0002 } from './Migration0002.js';
import { up as up0003 } from './Migration0003.js';
import { migrationChecksums } from './MigrationChecksums.js';
import { make, type Tables } from './Tables.js';

export class MigrationChecksumMismatchError extends Data.TaggedError(
	'MigrationChecksumMismatchError',
)<{ readonly version: number }> {}

interface Migration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly up: (
		sql: PgClient.PgClient,
		tables: Tables,
	) => Effect.Effect<unknown, unknown>;
}
const migrations: ReadonlyArray<Migration> = Object.freeze([
	{
		version: 1,
		name: 'tfx-core',
		checksum: migrationChecksums[1],
		up: up0001,
	},
	{
		version: 2,
		name: 'dedup-outcome-invariant',
		checksum: migrationChecksums[2],
		up: up0002,
	},
	{
		version: 3,
		name: 'job-state-invariant',
		checksum: migrationChecksums[3],
		up: up0003,
	},
]);

export const migrate = (options: Options = {}) =>
	Effect.flatMap(PgClient.PgClient, (sql) => {
		const tables = make(options);
		const schema = sql(tables.schema);
		const ledger = sql(tables.migrations);
		return sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tables.schema}:${options.tablePrefix ?? 'tfx_'}`}, 0))`;
				yield* sql`CREATE SCHEMA IF NOT EXISTS ${schema}`;
				yield* sql`CREATE TABLE IF NOT EXISTS ${schema}.${ledger} (
					version integer PRIMARY KEY,
					name text NOT NULL,
					checksum text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now()
				)`;
				const applied = yield* sql<{
					version: number;
					name: string;
					checksum: string;
				}>`SELECT version,name,checksum FROM ${schema}.${ledger} ORDER BY version`;
				const byVersion = new Map(applied.map((row) => [row.version, row]));
				for (const migration of migrations) {
					const existing = byVersion.get(migration.version);
					if (existing !== undefined) {
						if (
							existing.name !== migration.name ||
							existing.checksum !== migration.checksum
						)
							return yield* Effect.fail(
								new MigrationChecksumMismatchError({
									version: migration.version,
								}),
							);
						continue;
					}
					yield* migration.up(sql, tables);
					yield* sql`INSERT INTO ${schema}.${ledger} (version,name,checksum) VALUES (${migration.version},${migration.name},${migration.checksum})`;
				}
			}),
		);
	}).pipe(Effect.asVoid);

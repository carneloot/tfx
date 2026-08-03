import type { Migration } from '@tfx/postgres-migrator/Migration';
import * as PostgresMigrator from '@tfx/postgres-migrator/PostgresMigrator';
import * as Effect from 'effect/Effect';

import { up as up0001 } from './internal/Migration0001.js';
import { up as up0002 } from './internal/Migration0002.js';
import { up as up0003 } from './internal/Migration0003.js';
import { up as up0004 } from './internal/Migration0004.js';
import { migrationChecksums } from './internal/MigrationChecksums.js';
import { make } from './internal/Tables.js';
import type { Options } from './Options.js';

export const migrate = (options: Options = {}) => {
	const tables = make(options);
	const migrations: ReadonlyArray<Migration> = Object.freeze([
		{
			version: 1,
			name: 'tfx-core',
			checksum: migrationChecksums[1],
			up: (sql) => up0001(sql, tables).pipe(Effect.asVoid),
		},
		{
			version: 2,
			name: 'dedup-outcome-invariant',
			checksum: migrationChecksums[2],
			up: (sql) => up0002(sql, tables).pipe(Effect.asVoid),
		},
		{
			version: 3,
			name: 'job-state-invariant',
			checksum: migrationChecksums[3],
			up: (sql) => up0003(sql, tables).pipe(Effect.asVoid),
		},
		{
			version: 4,
			name: 'conversation-trace-context',
			checksum: migrationChecksums[4],
			up: (sql) => up0004(sql, tables).pipe(Effect.asVoid),
		},
	]);
	return PostgresMigrator.run({
		schema: tables.schema,
		table: tables.migrations,
		lockKey: `${tables.schema}:${tables.migrations}`,
		logPrefix: 'tfx.postgres',
		migrations,
	});
};

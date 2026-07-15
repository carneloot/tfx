import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../domain/DomainError.js';
import {
	type MigrationIdentity,
	validateAppliedMigrations,
} from './internal/MigrationLedger.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';
import { migration0002Checksum, migration0002Sql } from './Migration0002Sql.js';
import { migration0003Checksum, migration0003Sql } from './Migration0003Sql.js';

interface Migration extends MigrationIdentity {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly sql: string;
}
const migrations: ReadonlyArray<Migration> = Object.freeze([
	{
		version: 1,
		name: 'identity-pets',
		checksum: migration0001Checksum,
		sql: migration0001Sql,
	},
	{
		version: 2,
		name: 'pet-food',
		checksum: migration0002Checksum,
		sql: migration0002Sql,
	},
	{
		version: 3,
		name: 'pet-food-source-constraints',
		checksum: migration0003Checksum,
		sql: migration0003Sql,
	},
]);
const persistence = (cause: unknown) =>
	new DomainPersistenceError({ message: 'Carneloot migration failed', cause });

export const migrate = Effect.flatMap(PgClient.PgClient, (sql) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('carneloot:app_migrations', 0))`;
			yield* sql`CREATE SCHEMA IF NOT EXISTS carneloot`;
			yield* sql`CREATE TABLE IF NOT EXISTS carneloot.app_migrations (
				version integer PRIMARY KEY,
				name text NOT NULL,
				checksum text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`;
			const applied = yield* sql<{
				version: number;
				name: string;
				checksum: string;
			}>`SELECT version,name,checksum FROM carneloot.app_migrations ORDER BY version`;
			yield* validateAppliedMigrations(migrations, applied);
			for (const migration of migrations.slice(applied.length)) {
				yield* sql.unsafe(migration.sql);
				yield* sql`INSERT INTO carneloot.app_migrations (version,name,checksum) VALUES (${migration.version},${migration.name},${migration.checksum})`;
			}
		}),
	),
).pipe(
	Effect.mapError((cause) =>
		cause instanceof DomainPersistenceError ? cause : persistence(cause),
	),
	Effect.asVoid,
);

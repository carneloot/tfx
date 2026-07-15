import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';
import { migration0002Checksum, migration0002Sql } from './Migration0002Sql.js';

interface Migration {
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
			const byVersion = new Map(applied.map((row) => [row.version, row]));
			for (const migration of migrations) {
				const existing = byVersion.get(migration.version);
				if (existing !== undefined) {
					if (
						existing.name !== migration.name ||
						existing.checksum !== migration.checksum
					)
						return yield* Effect.fail(
							new DomainPersistenceError({
								message: `Carneloot migration ${migration.version} checksum mismatch`,
							}),
						);
					continue;
				}
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

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';

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
			const rows = yield* sql<{
				version: number;
				name: string;
				checksum: string;
			}>`SELECT version,name,checksum FROM carneloot.app_migrations WHERE version=1`;
			const existing = rows[0];
			if (existing !== undefined) {
				if (
					existing.name !== 'identity-pets' ||
					existing.checksum !== migration0001Checksum
				)
					return yield* Effect.fail(
						new DomainPersistenceError({
							message: 'Carneloot migration 1 checksum mismatch',
						}),
					);
				return;
			}
			yield* sql.unsafe(migration0001Sql);
			yield* sql`INSERT INTO carneloot.app_migrations (version,name,checksum) VALUES (1,'identity-pets',${migration0001Checksum})`;
		}),
	),
).pipe(
	Effect.mapError((cause) =>
		cause instanceof DomainPersistenceError ? cause : persistence(cause),
	),
	Effect.asVoid,
);

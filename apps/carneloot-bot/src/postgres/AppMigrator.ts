import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Ref from 'effect/Ref';

import { DomainPersistenceError } from '../domain/DomainError.js';
import {
	type MigrationIdentity,
	validateAppliedMigrations,
} from './internal/MigrationLedger.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';
import { migration0002Checksum, migration0002Sql } from './Migration0002Sql.js';
import { migration0003Checksum, migration0003Sql } from './Migration0003Sql.js';
import { migration0004Checksum, migration0004Sql } from './Migration0004Sql.js';
import { migration0005Checksum, migration0005Sql } from './Migration0005Sql.js';

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
	{
		version: 4,
		name: 'notifications',
		checksum: migration0004Checksum,
		sql: migration0004Sql,
	},
	{
		version: 5,
		name: 'unreachable-notification-deliveries',
		checksum: migration0005Checksum,
		sql: migration0005Sql,
	},
]);
const persistence = (cause: unknown) =>
	new DomainPersistenceError({ message: 'Carneloot migration failed', cause });

export const migrate = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const failureLogged = yield* Ref.make(false);
	const logFailure = (annotations: Record<string, unknown>) =>
		Ref.set(failureLogged, true).pipe(
			Effect.andThen(
				Effect.logError('carneloot.migrations.failed').pipe(
					Effect.annotateLogs(annotations),
				),
			),
		);
	const transaction = sql.withTransaction(
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
			yield* Effect.logInfo('carneloot.migrations.started').pipe(
				Effect.annotateLogs({
					applied: applied.length,
					pending: Math.max(0, migrations.length - applied.length),
				}),
			);
			const validation: Effect.Effect<void, DomainPersistenceError> =
				validateAppliedMigrations(migrations, applied);
			yield* validation.pipe(
				Effect.tapError(() => logFailure({ stage: 'ledger_validation' })),
			);
			for (const migration of migrations.slice(applied.length)) {
				yield* Effect.gen(function* () {
					yield* sql.unsafe(migration.sql);
					yield* sql`INSERT INTO carneloot.app_migrations (version,name,checksum) VALUES (${migration.version},${migration.name},${migration.checksum})`;
				}).pipe(
					Effect.tapError(() =>
						logFailure({
							stage: 'apply',
							version: migration.version,
							name: migration.name,
						}),
					),
				);
				yield* Effect.logInfo('carneloot.migration.applied').pipe(
					Effect.annotateLogs({
						version: migration.version,
						name: migration.name,
					}),
				);
			}
			yield* Effect.logInfo('carneloot.migrations.completed').pipe(
				Effect.annotateLogs({
					total: migrations.length,
					appliedNow: migrations.length - applied.length,
				}),
			);
		}),
	);
	yield* transaction.pipe(
		Effect.tapError(() =>
			Effect.flatMap(Ref.get(failureLogged), (logged) =>
				logged ? Effect.void : logFailure({ stage: 'transaction' }),
			),
		),
	);
}).pipe(
	Effect.mapError((cause) =>
		cause instanceof DomainPersistenceError ? cause : persistence(cause),
	),
	Effect.asVoid,
);

import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import {
	validateAppliedMigrations,
	validateManifest,
} from './internal/MigrationLedger.js';
import type { Options, Result } from './Migration.js';
import { MigrationError, type MigrationStage } from './MigrationError.js';

const failure = (
	stage: MigrationStage,
	message: string,
	cause?: unknown,
	migration?: { readonly version: number; readonly name: string },
) =>
	new MigrationError({
		stage,
		message,
		...(cause === undefined ? {} : { cause }),
		...(migration === undefined
			? {}
			: {
					version: migration.version,
					migrationName: migration.name,
				}),
	});

const protect = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	stage: MigrationStage,
	message: string,
	migration?: { readonly version: number; readonly name: string },
): Effect.Effect<A, MigrationError, R> =>
	effect.pipe(
		Effect.mapError((cause) =>
			cause instanceof MigrationError
				? cause
				: failure(stage, message, cause, migration),
		),
	);

export const run = (
	options: Options,
): Effect.Effect<Result, MigrationError, PgClient.PgClient> =>
	Effect.gen(function* () {
		yield* validateManifest(options.migrations);
		const sql = yield* PgClient.PgClient;
		const schema = sql(options.schema);
		const table = sql(options.table);
		return yield* protect(
			sql.withTransaction(
				Effect.gen(function* () {
					yield* protect(
						sql`SELECT pg_advisory_xact_lock(hashtextextended(${options.lockKey}, 0))`,
						'bootstrap',
						'Failed to acquire migration lock',
					);
					yield* protect(
						sql`CREATE SCHEMA IF NOT EXISTS ${schema}`,
						'bootstrap',
						'Failed to create migration schema',
					);
					yield* protect(
						sql`CREATE TABLE IF NOT EXISTS ${schema}.${table} (
							version integer PRIMARY KEY,
							name text NOT NULL,
							checksum text NOT NULL,
							applied_at timestamptz NOT NULL DEFAULT now()
						)`,
						'bootstrap',
						'Failed to create migration ledger',
					);
					const applied = yield* protect(
						sql<{
							version: number;
							name: string;
							checksum: string;
						}>`SELECT version,name,checksum FROM ${schema}.${table} ORDER BY version`,
						'bootstrap',
						'Failed to read migration ledger',
					);
					yield* Effect.logInfo(`${options.logPrefix}.migrations.started`).pipe(
						Effect.annotateLogs({
							applied: applied.length,
							pending: Math.max(0, options.migrations.length - applied.length),
						}),
					);
					yield* validateAppliedMigrations(options.migrations, applied);
					for (const migration of options.migrations.slice(applied.length)) {
						yield* protect(
							migration.up(sql),
							'apply',
							`Migration ${migration.version}_${migration.name} failed`,
							migration,
						);
						yield* protect(
							sql`INSERT INTO ${schema}.${table} (version,name,checksum) VALUES (${migration.version},${migration.name},${migration.checksum})`,
							'apply',
							`Failed to record migration ${migration.version}_${migration.name}`,
							migration,
						);
						yield* Effect.logInfo(
							`${options.logPrefix}.migration.applied`,
						).pipe(
							Effect.annotateLogs({
								version: migration.version,
								name: migration.name,
							}),
						);
					}
					const result = {
						total: options.migrations.length,
						applied: applied.length,
						appliedNow: options.migrations.length - applied.length,
					} satisfies Result;
					yield* Effect.logInfo(
						`${options.logPrefix}.migrations.completed`,
					).pipe(
						Effect.annotateLogs({
							total: result.total,
							appliedNow: result.appliedNow,
						}),
					);
					return result;
				}),
			),
			'transaction',
			'Migration transaction failed',
		);
	}).pipe(
		Effect.tapError((error) =>
			Effect.logError(`${options.logPrefix}.migrations.failed`).pipe(
				Effect.annotateLogs({
					stage: error.stage,
					...(error.version === undefined ? {} : { version: error.version }),
					...(error.migrationName === undefined
						? {}
						: { name: error.migrationName }),
				}),
			),
		),
	);

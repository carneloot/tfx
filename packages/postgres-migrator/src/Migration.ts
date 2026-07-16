import type * as PgClient from '@effect/sql-pg/PgClient';
import type * as Effect from 'effect/Effect';

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly up: (sql: PgClient.PgClient) => Effect.Effect<unknown, unknown>;
}

export interface AppliedMigration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}

export interface Options {
	readonly schema: string;
	readonly table: string;
	readonly lockKey: string;
	readonly logPrefix: string;
	readonly migrations: ReadonlyArray<Migration>;
}

export interface Result {
	readonly total: number;
	readonly applied: number;
	readonly appliedNow: number;
}

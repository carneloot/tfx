import type { Migration } from '@tfx/postgres-migrator/Migration';
import * as PostgresMigrator from '@tfx/postgres-migrator/PostgresMigrator';
import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';
import { migration0002Checksum, migration0002Sql } from './Migration0002Sql.js';
import { migration0003Checksum, migration0003Sql } from './Migration0003Sql.js';
import { migration0004Checksum, migration0004Sql } from './Migration0004Sql.js';
import { migration0005Checksum, migration0005Sql } from './Migration0005Sql.js';
import { migration0006Checksum, migration0006Sql } from './Migration0006Sql.js';
import { migration0007Checksum, migration0007Sql } from './Migration0007Sql.js';
import { migration0008Checksum, migration0008Sql } from './Migration0008Sql.js';
import { migration0009Checksum, migration0009Sql } from './Migration0009Sql.js';
import { migration0010Checksum, migration0010Sql } from './Migration0010Sql.js';

const sqlMigration = (
	version: number,
	name: string,
	checksum: string,
	source: string,
): Migration => ({
	version,
	name,
	checksum,
	up: (sql) => sql.unsafe(source).pipe(Effect.asVoid),
});

const migrations: ReadonlyArray<Migration> = Object.freeze([
	sqlMigration(1, 'identity-pets', migration0001Checksum, migration0001Sql),
	sqlMigration(2, 'pet-food', migration0002Checksum, migration0002Sql),
	sqlMigration(
		3,
		'pet-food-source-constraints',
		migration0003Checksum,
		migration0003Sql,
	),
	sqlMigration(4, 'notifications', migration0004Checksum, migration0004Sql),
	sqlMigration(
		5,
		'unreachable-notification-deliveries',
		migration0005Checksum,
		migration0005Sql,
	),
	sqlMigration(6, 'pet-caregivers', migration0006Checksum, migration0006Sql),
	sqlMigration(
		7,
		'notification-recipient-freeze',
		migration0007Checksum,
		migration0007Sql,
	),
	sqlMigration(
		8,
		'food-reply-operations',
		migration0008Checksum,
		migration0008Sql,
	),
	sqlMigration(9, 'import-targets', migration0009Checksum, migration0009Sql),
	sqlMigration(
		10,
		'external-notification-payload',
		migration0010Checksum,
		migration0010Sql,
	),
]);

export const migrate = PostgresMigrator.run({
	schema: 'carneloot',
	table: 'app_migrations',
	lockKey: 'carneloot:app_migrations',
	logPrefix: 'carneloot',
	migrations,
}).pipe(
	Effect.mapError(
		(cause) =>
			new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'Carneloot migration failed',
				cause,
			}),
	),
	Effect.asVoid,
);

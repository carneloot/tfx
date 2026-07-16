import * as Effect from 'effect/Effect';

import type { AppliedMigration, Migration } from '../Migration.js';
import { MigrationError } from '../MigrationError.js';

const invalid = (
	stage: 'manifest_validation' | 'ledger_validation',
	message: string,
) => new MigrationError({ stage, message });

export const validateManifest = (
	migrations: ReadonlyArray<Migration>,
): Effect.Effect<void, MigrationError> => {
	for (const [index, migration] of migrations.entries()) {
		const expectedVersion = index + 1;
		if (migration.version !== expectedVersion)
			return Effect.fail(
				invalid(
					'manifest_validation',
					`expected version ${expectedVersion} at position ${index}, received ${migration.version}`,
				),
			);
		if (migration.name.trim().length === 0)
			return Effect.fail(
				invalid(
					'manifest_validation',
					`migration ${migration.version} has an empty name`,
				),
			);
		if (!/^[0-9a-f]{64}$/u.test(migration.checksum))
			return Effect.fail(
				invalid(
					'manifest_validation',
					`migration ${migration.version} has an invalid SHA-256 checksum`,
				),
			);
	}
	return Effect.void;
};

export const validateAppliedMigrations = (
	migrations: ReadonlyArray<Migration>,
	applied: ReadonlyArray<AppliedMigration>,
): Effect.Effect<void, MigrationError> => {
	if (applied.length > migrations.length)
		return Effect.fail(
			invalid('ledger_validation', 'unknown future migration version'),
		);
	for (const [index, actual] of applied.entries()) {
		const expected = migrations[index];
		if (expected === undefined)
			return Effect.fail(
				invalid('ledger_validation', 'unknown future migration version'),
			);
		if (actual.version !== expected.version)
			return Effect.fail(
				invalid(
					'ledger_validation',
					`expected version ${expected.version} at position ${index}, received ${actual.version}`,
				),
			);
		if (actual.name !== expected.name || actual.checksum !== expected.checksum)
			return Effect.fail(
				invalid(
					'ledger_validation',
					`migration ${expected.version} identity/checksum mismatch`,
				),
			);
	}
	return Effect.void;
};

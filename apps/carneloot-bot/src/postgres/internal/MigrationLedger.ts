import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../../domain/DomainError.js';

export interface MigrationIdentity {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}
const invalid = (message: string) =>
	new DomainPersistenceError({
		message: `Invalid migration ledger: ${message}`,
	});

/** Validates that applied rows are exactly migrations[0..n), without gaps or futures. */
export const validateAppliedMigrations = (
	migrations: ReadonlyArray<MigrationIdentity>,
	applied: ReadonlyArray<MigrationIdentity>,
) => {
	if (applied.length > migrations.length)
		return Effect.fail(invalid('unknown future migration version'));
	for (const [index, actual] of applied.entries()) {
		const expected = migrations[index];
		if (expected === undefined)
			return Effect.fail(invalid('unknown future migration version'));
		if (actual.version !== expected.version)
			return Effect.fail(
				invalid(
					`expected version ${expected.version} at position ${index}, received ${actual.version}`,
				),
			);
		if (actual.name !== expected.name || actual.checksum !== expected.checksum)
			return Effect.fail(
				invalid(`migration ${expected.version} identity/checksum mismatch`),
			);
	}
	return Effect.void;
};

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	type MigrationIdentity,
	validateAppliedMigrations,
} from '../src/postgres/internal/MigrationLedger.js';
const known: ReadonlyArray<MigrationIdentity> = [
	{ version: 1, name: 'one', checksum: 'a' },
	{ version: 2, name: 'two', checksum: 'b' },
];
const result = (applied: ReadonlyArray<MigrationIdentity>) =>
	Effect.runPromise(Effect.result(validateAppliedMigrations(known, applied)));
describe('migration ledger validation', () => {
	it.each([
		{ applied: [] },
		{ applied: [known[0]!] },
		{ applied: known },
	] satisfies ReadonlyArray<{ applied: ReadonlyArray<MigrationIdentity> }>)(
		'accepts an exact contiguous prefix',
		async ({ applied }) => {
			expect(await result(applied)).toMatchObject({ _tag: 'Success' });
		},
	);
	it.each([
		{ applied: [{ version: 2, name: 'two', checksum: 'b' }] },
		{ applied: [known[0]!, { version: 3, name: 'future', checksum: 'c' }] },
		{ applied: [known[0]!, known[0]!] },
		{
			applied: [
				known[0]!,
				known[1]!,
				{ version: 3, name: 'future', checksum: 'c' },
			],
		},
	] satisfies ReadonlyArray<{ applied: ReadonlyArray<MigrationIdentity> }>)(
		'rejects gaps, duplicates, ordering errors, and futures',
		async ({ applied }) => {
			expect(await result(applied)).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'DomainPersistenceError' },
			});
		},
	);
	it('retains migration name and checksum validation', async () => {
		expect(
			await result([{ version: 1, name: 'one', checksum: 'drift' }]),
		).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'DomainPersistenceError' },
		});
	});
});

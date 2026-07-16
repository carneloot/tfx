import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	validateAppliedMigrations,
	validateManifest,
} from '../src/internal/MigrationLedger.js';
import type { Migration } from '../src/Migration.js';

const checksum = (character: string) => character.repeat(64);
const migration = (
	version: number,
	name: string,
	digest: string,
): Migration => ({
	version,
	name,
	checksum: digest,
	up: () => Effect.void,
});
const known = [
	migration(1, 'one', checksum('a')),
	migration(2, 'two', checksum('b')),
] as const;
const result = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.result(effect));

describe('migration manifest validation', () => {
	it('accepts a contiguous manifest with SHA-256 identities', async () => {
		expect(await result(validateManifest(known))).toMatchObject({
			_tag: 'Success',
		});
	});

	it.each([
		[migration(2, 'one', checksum('a'))],
		[known[0], migration(3, 'three', checksum('c'))],
		[migration(1, '', checksum('a'))],
		[migration(1, '   ', checksum('a'))],
		[migration(1, 'one', checksum('A'))],
		[migration(1, 'one', 'a'.repeat(63))],
		[migration(1, 'one', 'a'.repeat(65))],
		[migration(1, 'one', 'not-a-sha256')],
	] as const)('rejects malformed source manifests', async (...manifest) => {
		expect(await result(validateManifest(manifest))).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'MigrationError',
				stage: 'manifest_validation',
			},
		});
	});
});

describe('applied migration validation', () => {
	it.each([
		{ applied: [] },
		{
			applied: [{ version: 1, name: 'one', checksum: checksum('a') }],
		},
		{
			applied: [
				{ version: 1, name: 'one', checksum: checksum('a') },
				{ version: 2, name: 'two', checksum: checksum('b') },
			],
		},
	] as const)('accepts an exact source prefix', async ({ applied }) => {
		expect(
			await result(validateAppliedMigrations(known, applied)),
		).toMatchObject({ _tag: 'Success' });
	});

	it.each([
		{
			applied: [{ version: 2, name: 'two', checksum: checksum('b') }],
		},
		{
			applied: [
				{ version: 1, name: 'one', checksum: checksum('a') },
				{ version: 3, name: 'future', checksum: checksum('c') },
			],
		},
		{
			applied: [{ version: 1, name: 'renamed', checksum: checksum('a') }],
		},
		{
			applied: [{ version: 1, name: 'one', checksum: checksum('f') }],
		},
	] as const)(
		'rejects gaps, futures, names, and checksum drift',
		async ({ applied }) => {
			expect(
				await result(validateAppliedMigrations(known, applied)),
			).toMatchObject({
				_tag: 'Failure',
				failure: {
					_tag: 'MigrationError',
					stage: 'ledger_validation',
				},
			});
		},
	);
});

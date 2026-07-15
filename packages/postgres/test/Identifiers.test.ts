import { describe, expect, it } from 'vitest';

import { identifier } from '../src/internal/Identifiers.js';
import { make } from '../src/internal/Tables.js';
describe('PostgreSQL identifiers', () => {
	it.each(['tfx', 'tenant_1', '_private'])('accepts %s', (value) =>
		expect(identifier(value)).toBe(value),
	);
	it.each(['', '1tenant', 'Tenant', 'tenant-name', 'tenant"x', 'á'])(
		'rejects %s',
		(value) => expect(() => identifier(value)).toThrow(),
	);
	it('derives migration and constraint identifiers from the configured prefix', () => {
		expect(make({ tablePrefix: 'case_' })).toMatchObject({
			migrations: 'case_migrations',
			dedupOutcomeConstraint: 'case_dedup_outcome_chk',
		});
	});

	it('enforces PostgreSQL byte limit on identifiers and composed names', () => {
		expect(() => identifier(`a${'x'.repeat(63)}`)).toThrow('63-byte');
		expect(() => make({ tablePrefix: `a${'x'.repeat(45)}` })).toThrow(
			'63-byte',
		);
	});
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	migration0001Checksum,
	migration0001Sql,
} from '../src/postgres/Migration0001Sql.js';
describe('identity migration artifact', () => {
	it('matches committed SQL and immutable SHA-256 checksum', () => {
		const source = readFileSync(
			new URL('../migrations/0001_identity_pets.sql', import.meta.url),
			'utf8',
		);
		expect(migration0001Sql).toBe(source);
		expect(createHash('sha256').update(source).digest('hex')).toBe(
			migration0001Checksum,
		);
	});
});

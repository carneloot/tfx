import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	migration0001Checksum,
	migration0001Sql,
} from '../src/postgres/Migration0001Sql.js';
import {
	migration0002Checksum,
	migration0002Sql,
} from '../src/postgres/Migration0002Sql.js';
import {
	migration0003Checksum,
	migration0003Sql,
} from '../src/postgres/Migration0003Sql.js';
describe('application migration artifacts', () => {
	it.each([
		['0001_identity_pets.sql', migration0001Sql, migration0001Checksum],
		['0002_pet_food.sql', migration0002Sql, migration0002Checksum],
		[
			'0003_pet_food_source_constraints.sql',
			migration0003Sql,
			migration0003Checksum,
		],
	] as const)(
		'matches committed %s bytes and SHA-256',
		(file, sql, checksum) => {
			const source = readFileSync(
				new URL(`../migrations/${file}`, import.meta.url),
				'utf8',
			);
			expect(sql).toBe(source);
			expect(createHash('sha256').update(source).digest('hex')).toBe(checksum);
		},
	);
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL migration bootstrap ordering', () => {
	it('takes the transaction advisory lock before bootstrap DDL', () => {
		const source = readFileSync(
			new URL('../src/internal/Migrator.ts', import.meta.url),
			'utf8',
		);
		const transaction = source.slice(source.indexOf('sql.withTransaction'));
		const lock = transaction.indexOf('pg_advisory_xact_lock');
		const createSchema = transaction.indexOf('CREATE SCHEMA');
		const createLedger = transaction.indexOf('CREATE TABLE');
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(createSchema);
		expect(lock).toBeLessThan(createLedger);
	});
});

import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	NullableInteger,
	NullableTimestamp,
	RawInteger,
	Timestamp,
	Uuid,
} from '../src/internal/RowValidation.js';

describe('PostgreSQL row validation schemas', () => {
	it('validates non-sentinel RFC UUIDs', () => {
		const decode = Schema.decodeUnknownSync(Uuid);
		expect(decode('00000000-0000-4000-8000-000000000001')).toBe(
			'00000000-0000-4000-8000-000000000001',
		);
		for (const invalid of [
			'not-a-uuid',
			'00000000-0000-0000-0000-000000000000',
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
		])
			expect(() => decode(invalid)).toThrow();
	});

	it('normalizes safe bigint numbers and strings', () => {
		const decode = Schema.decodeUnknownSync(RawInteger);
		expect(decode(42)).toBe(42);
		expect(decode('42')).toBe(42);
		for (const invalid of [
			'1.5',
			'not-a-number',
			'9007199254740992',
			Number.POSITIVE_INFINITY,
		])
			expect(() => decode(invalid)).toThrow();
		expect(Schema.decodeUnknownSync(NullableInteger)(null)).toBeNull();
	});

	it('normalizes supported timestamp representations to DateTime.Utc', () => {
		const decode = Schema.decodeUnknownSync(Timestamp);
		const instant = '2024-01-02T03:04:05.000Z';
		expect(DateTime.formatIso(decode(instant))).toBe(instant);
		expect(DateTime.formatIso(decode(Date.parse(instant)))).toBe(instant);
		expect(Schema.decodeUnknownSync(NullableTimestamp)(null)).toBeNull();
		for (const invalid of ['not-a-date', Number.NaN, {}])
			expect(() => decode(invalid)).toThrow();
	});
});

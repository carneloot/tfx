import { DateTime, Duration, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	DurationMillis,
	PositiveDurationMillis,
	Timestamp,
} from '../src/internal/RowValidation.js';

describe('PostgreSQL row temporal codecs', () => {
	it('decodes PostgreSQL timestamps to UTC DateTime', () => {
		const instant = '2024-01-02T03:04:05.000Z';
		const decode = Schema.decodeUnknownSync(Timestamp);
		for (const input of [new Date(instant), instant, Date.parse(instant)])
			expect(DateTime.formatIso(decode(input))).toBe(instant);
		for (const invalid of ['bad', Number.NaN, new Date(Number.NaN)])
			expect(() => decode(invalid)).toThrow();
	});

	it('round-trips persisted duration millis', () => {
		const decode = Schema.decodeUnknownSync(DurationMillis);
		const encode = Schema.encodeSync(DurationMillis);
		const duration = decode(1_500);
		expect(Duration.toMillis(duration)).toBe(1_500);
		expect(encode(duration)).toBe(1_500);
	});

	it('rejects invalid persisted durations', () => {
		const decode = Schema.decodeUnknownSync(DurationMillis);
		const decodePositive = Schema.decodeUnknownSync(PositiveDurationMillis);
		for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => decode(invalid)).toThrow();
		expect(() => decodePositive(0)).toThrow();
		expect(Duration.toMillis(decodePositive(1))).toBe(1);
	});
});

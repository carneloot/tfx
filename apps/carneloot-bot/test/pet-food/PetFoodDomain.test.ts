import { Duration, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { ReminderDelay } from '../../src/domain/pet-food/PetFood.js';

const decode = Schema.decodeUnknownSync(ReminderDelay);

describe('ReminderDelay', () => {
	it.each([
		['1ms', Duration.millis(1)],
		['30 days', Duration.days(30)],
	] as const)('accepts %s', (_label, value) => {
		expect(Duration.equals(decode(value), value)).toBe(true);
	});

	it.each([
		['zero', Duration.zero],
		['sub-millisecond', Duration.nanos(500_000n)],
		['30 days + 1ms', Duration.sum(Duration.days(30), Duration.millis(1))],
	] as const)('rejects %s', (_label, value) => {
		expect(() => decode(value)).toThrow();
	});
});

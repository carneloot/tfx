import { DateTime, Duration, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { current } from '../../src/domain/pet-food/DayBoundary.js';
import {
	IanaTimeZone,
	LocalTime,
} from '../../src/domain/pet-food/FoodDateTime.js';
const instant = (value: string) => DateTime.makeUnsafe(value);
const settings = (localTime: string, timeZone: string) => ({
	localTime: Schema.decodeUnknownSync(LocalTime)(localTime),
	timeZone: Schema.decodeUnknownSync(IanaTimeZone)(timeZone),
});
describe('DayBoundary', () => {
	it.each([
		['2024-01-02T00:00:00Z', '00:00', '2024-01-02T00:00:00Z'],
		['2024-01-02T22:59:59Z', '23:00', '2024-01-01T23:00:00Z'],
		['2024-01-02T23:00:00Z', '23:00', '2024-01-02T23:00:00Z'],
	] as const)('selects current UTC window at %s', (now, localTime, start) => {
		const window = current(instant(now), settings(localTime, 'UTC'));
		expect(DateTime.Equivalence(window.start, instant(start))).toBe(true);
		expect(
			Duration.equals(
				DateTime.distance(window.start, window.end),
				Duration.hours(24),
			),
		).toBe(true);
	});
	it('uses 23-hour and 25-hour local calendar days', () => {
		const spring = current(
			instant('2024-03-10T16:00:00Z'),
			settings('00:00', 'America/New_York'),
		);
		const fall = current(
			instant('2024-11-03T17:00:00Z'),
			settings('00:00', 'America/New_York'),
		);
		expect(
			Duration.equals(
				DateTime.distance(spring.start, spring.end),
				Duration.hours(23),
			),
		).toBe(true);
		expect(
			Duration.equals(
				DateTime.distance(fall.start, fall.end),
				Duration.hours(25),
			),
		).toBe(true);
	});
	it('uses compatible gap and earlier repeated boundary policies', () => {
		const gap = current(
			instant('2024-03-10T12:00:00Z'),
			settings('02:30', 'America/New_York'),
		);
		const repeated = current(
			instant('2024-11-03T12:00:00Z'),
			settings('01:30', 'America/New_York'),
		);
		expect(DateTime.formatIso(gap.start)).toBe('2024-03-10T07:30:00.000Z');
		expect(DateTime.formatIso(repeated.start)).toBe('2024-11-03T05:30:00.000Z');
	});
});

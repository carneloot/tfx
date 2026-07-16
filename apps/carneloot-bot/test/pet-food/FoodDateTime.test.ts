import { DateTime, Effect, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import {
	IanaTimeZone,
	LocalTime,
	parse,
} from '../../src/domain/pet-food/FoodDateTime.js';

const zone = Schema.decodeUnknownSync(IanaTimeZone)('America/New_York');
const instant = (value: string) => DateTime.makeUnsafe(value);
const expectInstant = async (
	actual: Promise<DateTime.Utc>,
	expected: string,
) => {
	expect(DateTime.Equivalence(await actual, instant(expected))).toBe(true);
};
const runAt = <A, E>(now: string, effect: Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(instant(now)));
			return yield* effect;
		}).pipe(Effect.provide(TestClock.layer())),
	);
describe('FoodDateTime', () => {
	it('validates named IANA zones and exact HH:mm', () => {
		expect(Schema.decodeUnknownSync(IanaTimeZone)('UTC')).toBe('UTC');
		expect(() => Schema.decodeUnknownSync(IanaTimeZone)('+03:00')).toThrow();
		expect(Schema.decodeUnknownSync(LocalTime)('00:00')).toBe('00:00');
		expect(Schema.decodeUnknownSync(LocalTime)('23:59')).toBe('23:59');
		expect(() => Schema.decodeUnknownSync(LocalTime)('24:00')).toThrow();
		expect(() => Schema.decodeUnknownSync(LocalTime)('1:00')).toThrow();
	});
	it('parses time-only, yearless, and explicit dates in the pet zone', async () => {
		await expectInstant(
			runAt('2024-01-15T15:00:00Z', parse('08:30', zone)),
			'2024-01-15T13:30:00Z',
		);
		await expectInstant(
			runAt('2024-01-15T15:00:00Z', parse('16/01 08:30', zone)),
			'2024-01-16T13:30:00Z',
		);
		await expectInstant(
			runAt('2024-01-15T15:00:00Z', parse('14-01 08:30', zone)),
			'2025-01-14T13:30:00Z',
		);
		await expectInstant(
			runAt('2024-01-15T15:00:00Z', parse('01/02/2020 08:30', zone)),
			'2020-02-01T13:30:00Z',
		);
	});
	it('rejects gaps and chooses the earlier repeated offset', async () => {
		await expect(
			runAt('2024-01-01T00:00:00Z', parse('10/03/2024 02:30', zone)),
		).rejects.toMatchObject({ reason: 'NonexistentLocalTime' });
		await expect(
			runAt('2024-01-01T00:00:00Z', parse('10/03 02:30', zone)),
		).rejects.toMatchObject({ reason: 'NonexistentLocalTime' });
		await expectInstant(
			runAt('2024-01-01T00:00:00Z', parse('03/11/2024 01:30', zone)),
			'2024-11-03T05:30:00Z',
		);
	});
	it('rolls a past yearless date across Dec 31 to Jan 1', async () => {
		await expectInstant(
			runAt('2024-12-31T15:00:00Z', parse('01/01 08:00', zone)),
			'2025-01-01T13:00:00Z',
		);
	});
	it('uses the nearest valid yearless leap date within 366 local days', async () => {
		await expectInstant(
			runAt('2023-03-01T15:00:00Z', parse('29/02 08:00', zone)),
			'2024-02-29T13:00:00Z',
		);
		await expect(
			runAt('2024-03-01T15:00:00Z', parse('29/02 08:00', zone)),
		).rejects.toMatchObject({ reason: 'NonexistentLocalTime' });
	});
	it.each(['1/01 08:00', '01.01 08:00', '31/02 08:00', '01/01 8:00'])(
		'rejects malformed %s',
		async (value) => {
			await expect(
				runAt('2024-01-01T00:00:00Z', parse(value, zone)),
			).rejects.toBeDefined();
		},
	);
});

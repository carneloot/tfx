import { DateTime, Effect, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as CommandInput from '../../../../packages/tfx/src/CommandInput.js';
import { parse as parseCommandInput } from '../../../../packages/tfx/src/internal/bot/CommandParser.js';
import {
	IanaTimeZone,
	LocalTime,
	parse,
} from '../../src/domain/pet-food/FoodDateTime.js';
import { FoodWhenInput } from '../../src/domain/pet-food/FoodWhenInput.js';

const zone = Schema.decodeUnknownSync(IanaTimeZone)('America/New_York');
const instant = (value: string) => DateTime.makeUnsafe(value);
const parsedAt = (input: string, messageDate: string) =>
	parse(input, zone, instant(messageDate));
const expectInstant = async (
	actual: Promise<DateTime.Utc>,
	expected: string,
) => {
	expect(DateTime.Equivalence(await actual, instant(expected))).toBe(true);
};
const runWithClock = <A, E>(now: string, effect: Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(instant(now)));
			return yield* effect;
		}).pipe(Effect.provide(TestClock.layer())),
	);

describe('FoodWhenInput', () => {
	it('lets CommandInput.optional represent omitted time', async () => {
		const input = CommandInput.sequence(
			CommandInput.argument('amount', Schema.String),
			CommandInput.optional(CommandInput.rest('when', FoodWhenInput)),
		);
		expect(await Effect.runPromise(parseCommandInput(input, '10g'))).toEqual({
			amount: '10g',
		});
	});

	it.each([
		'08:30',
		'16/01 08:30',
		'16-01 08:30',
		'16/01/2024 08:30',
		'16-01-2024 08:30',
	])('accepts supported syntax: %s', (value) => {
		expect(Schema.decodeUnknownSync(FoodWhenInput)(value)).toBe(value);
	});

	it.each([
		'',
		'16/01',
		'16/01-2024 08:30',
		'16/01 08:30 extra',
		'08:30:00',
		'1/01 08:00',
		'yesterday 08:30',
	])('rejects unsupported syntax: %s', (value) => {
		expect(() => Schema.decodeUnknownSync(FoodWhenInput)(value)).toThrow();
	});
});

describe('FoodDateTime', () => {
	it('validates named IANA zones and exact HH:mm', () => {
		expect(Schema.decodeUnknownSync(IanaTimeZone)('UTC')).toBe('UTC');
		expect(() => Schema.decodeUnknownSync(IanaTimeZone)('+03:00')).toThrow();
		expect(Schema.decodeUnknownSync(LocalTime)('00:00')).toBe('00:00');
		expect(Schema.decodeUnknownSync(LocalTime)('23:59')).toBe('23:59');
		expect(() => Schema.decodeUnknownSync(LocalTime)('24:00')).toThrow();
	});

	it('anchors time-only input to message local date and rolls future time back', async () => {
		await expectInstant(
			Effect.runPromise(parsedAt('08:30', '2024-01-15T15:00:00Z')),
			'2024-01-15T13:30:00Z',
		);
		await expectInstant(
			Effect.runPromise(parsedAt('16:00', '2024-01-15T15:00:00Z')),
			'2024-01-14T21:00:00Z',
		);
	});

	it('uses message date rather than delayed processing clock', async () => {
		await expectInstant(
			runWithClock(
				'2024-01-16T15:00:00Z',
				parsedAt('08:30', '2024-01-15T15:00:00Z'),
			),
			'2024-01-15T13:30:00Z',
		);
	});

	it('parses yearless and explicit dates in pet zone', async () => {
		await expectInstant(
			Effect.runPromise(parsedAt('16/01 08:30', '2024-01-15T15:00:00Z')),
			'2024-01-16T13:30:00Z',
		);
		await expectInstant(
			Effect.runPromise(parsedAt('14-01 08:30', '2024-01-15T15:00:00Z')),
			'2025-01-14T13:30:00Z',
		);
		await expectInstant(
			Effect.runPromise(parsedAt('01/02/2020 08:30', '2024-01-15T15:00:00Z')),
			'2020-02-01T13:30:00Z',
		);
	});

	it('rejects gaps and chooses earlier repeated offset', async () => {
		await expect(
			Effect.runPromise(parsedAt('10/03/2024 02:30', '2024-01-01T00:00:00Z')),
		).rejects.toMatchObject({ reason: 'NonexistentLocalTime' });
		await expectInstant(
			Effect.runPromise(parsedAt('03/11/2024 01:30', '2024-01-01T00:00:00Z')),
			'2024-11-03T05:30:00Z',
		);
	});

	it('uses nearest valid yearless leap date within 366 local days', async () => {
		await expectInstant(
			Effect.runPromise(parsedAt('29/02 08:00', '2023-03-01T15:00:00Z')),
			'2024-02-29T13:00:00Z',
		);
		await expect(
			Effect.runPromise(parsedAt('29/02 08:00', '2024-03-01T15:00:00Z')),
		).rejects.toMatchObject({ reason: 'NonexistentLocalTime' });
	});
});

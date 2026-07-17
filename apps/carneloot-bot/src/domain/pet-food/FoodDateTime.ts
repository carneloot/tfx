import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { PetFoodError } from './PetFoodError.js';

export const IanaTimeZone = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			!value.startsWith('+') &&
			!value.startsWith('-') &&
			Option.isSome(DateTime.zoneMakeNamed(value)),
		{ message: 'Expected a named IANA time zone' },
	),
).pipe(Schema.brand('IanaTimeZone'));
export type IanaTimeZone = typeof IanaTimeZone.Type;
export const LocalTime = Schema.String.check(
	Schema.makeFilter(
		(value) => /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value),
		{
			message: 'Expected HH:mm',
		},
	),
).pipe(Schema.brand('LocalTime'));
export type LocalTime = typeof LocalTime.Type;

interface LocalParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
}
const sameParts = (actual: DateTime.DateTime.Parts, expected: LocalParts) =>
	actual.year === expected.year &&
	actual.month === expected.month &&
	actual.day === expected.day &&
	actual.hour === expected.hour &&
	actual.minute === expected.minute;
const makeLocal = (
	parts: LocalParts,
	timeZone: IanaTimeZone,
): DateTime.Zoned | undefined => {
	const candidate = DateTime.makeZoned(
		{ ...parts, second: 0, millisecond: 0 },
		{
			timeZone,
			adjustForTimeZone: true,
			disambiguation: 'earlier',
		},
	);
	if (
		Option.isNone(candidate) ||
		!sameParts(DateTime.toParts(candidate.value), parts)
	)
		return undefined;
	return candidate.value;
};
const invalid = (
	message: string,
	reason: PetFoodError['reason'] = 'InvalidFoodDateTime',
) => new PetFoodError({ reason, message });
const dateOrder = (parts: Pick<LocalParts, 'year' | 'month' | 'day'>) =>
	parts.year * 10_000 + parts.month * 100 + parts.day;
const validCalendarDate = (parts: LocalParts): boolean => {
	const candidate = DateTime.make({
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: 12,
		minute: 0,
		second: 0,
		millisecond: 0,
	});
	if (Option.isNone(candidate)) return false;
	const actual = DateTime.toPartsUtc(candidate.value);
	return (
		actual.year === parts.year &&
		actual.month === parts.month &&
		actual.day === parts.day
	);
};

/** Parses a supported local food timestamp relative to its Telegram message. */
export const parse = (
	input: string,
	timeZone: IanaTimeZone,
	messageDate: DateTime.Utc,
) =>
	Effect.gen(function* () {
		if (Option.isNone(DateTime.zoneMakeNamed(timeZone)))
			return yield* Effect.fail(
				invalid('Invalid IANA time zone', 'InvalidTimeZone'),
			);
		const zonedMessageDate = DateTime.makeZonedUnsafe(messageDate, {
			timeZone,
		});
		const current = DateTime.toParts(zonedMessageDate);
		const timeOnly = /^(\d{2}):(\d{2})$/u.exec(input);
		let parts: LocalParts;
		let yearless = false;
		if (timeOnly !== null) {
			parts = {
				year: current.year,
				month: current.month,
				day: current.day,
				hour: Number(timeOnly[1]),
				minute: Number(timeOnly[2]),
			};
			const sameDay = makeLocal(parts, timeZone);
			if (
				sameDay !== undefined &&
				DateTime.toEpochMillis(sameDay) > DateTime.toEpochMillis(messageDate)
			) {
				const previous = DateTime.toParts(
					DateTime.subtract(zonedMessageDate, { days: 1 }),
				);
				parts = {
					...parts,
					year: previous.year,
					month: previous.month,
					day: previous.day,
				};
			}
		} else {
			const dated =
				/^(\d{2})([/-])(\d{2})(?:\2(\d{4}))? (\d{2}):(\d{2})$/u.exec(input);
			if (dated === null)
				return yield* Effect.fail(invalid('Unsupported food date/time format'));
			yearless = dated[4] === undefined;
			parts = {
				year: dated[4] === undefined ? current.year : Number(dated[4]),
				month: Number(dated[3]),
				day: Number(dated[1]),
				hour: Number(dated[5]),
				minute: Number(dated[6]),
			};
			if (
				yearless &&
				(dateOrder(parts) <
					dateOrder({
						year: current.year,
						month: current.month,
						day: current.day,
					}) ||
					!validCalendarDate(parts))
			)
				parts = { ...parts, year: current.year + 1 };
		}
		const parsed = makeLocal(parts, timeZone);
		if (parsed === undefined)
			return yield* Effect.fail(
				invalid('Invalid or nonexistent local time', 'NonexistentLocalTime'),
			);
		if (
			yearless &&
			DateTime.toEpochMillis(parsed) >
				DateTime.toEpochMillis(DateTime.add(zonedMessageDate, { days: 366 }))
		)
			return yield* Effect.fail(
				invalid('Yearless date is more than 366 local days away'),
			);
		return DateTime.toUtc(parsed);
	});

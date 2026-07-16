import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';

import type { IanaTimeZone, LocalTime } from './FoodDateTime.js';

export interface Settings {
	readonly localTime: LocalTime;
	readonly timeZone: IanaTimeZone;
}
export interface Window {
	readonly start: DateTime.Utc;
	readonly end: DateTime.Utc;
}
const boundary = (
	date: Pick<DateTime.DateTime.Parts, 'year' | 'month' | 'day'>,
	settings: Settings,
): DateTime.Zoned => {
	const [hourText, minuteText] = settings.localTime.split(':');
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const value = DateTime.makeZoned(
		{ ...date, hour, minute, second: 0, millisecond: 0 },
		{
			timeZone: settings.timeZone,
			adjustForTimeZone: true,
			disambiguation: 'compatible',
		},
	);
	if (Option.isNone(value))
		throw new Error('Validated day boundary was invalid');
	return value.value;
};
/** Returns a half-open local-calendar day window [start, end). */
export const current = (now: DateTime.Utc, settings: Settings): Window => {
	const zonedNow = DateTime.makeZonedUnsafe(now, {
		timeZone: settings.timeZone,
	});
	let start = boundary(DateTime.toParts(zonedNow), settings);
	if (DateTime.isGreaterThan(start, now)) {
		const previous = DateTime.subtract(zonedNow, { days: 1 });
		start = boundary(DateTime.toParts(previous), settings);
	}
	const following = DateTime.add(start, { days: 1 });
	const end = boundary(DateTime.toParts(following), settings);
	return {
		start: DateTime.toUtc(start),
		end: DateTime.toUtc(end),
	};
};

import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

export const RawInteger = Schema.Union([Schema.String, Schema.Number]);
export const NullableInteger = Schema.Union([
	Schema.Null,
	Schema.String,
	Schema.Number,
]);
export const NullableString = Schema.Union([Schema.Null, Schema.String]);
export const NullableUnknown = Schema.Union([Schema.Null, Schema.Unknown]);

export const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
export const NullableTimestamp = Schema.NullOr(Timestamp);
export const DurationMillis = Schema.DurationFromMillis.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && !Duration.isNegative(value),
		{ message: 'Expected a finite non-negative duration' },
	),
);
export const PositiveDurationMillis = Schema.DurationFromMillis.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && Duration.isPositive(value),
		{ message: 'Expected a finite positive duration' },
	),
);

export const CompletedOutcome = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal('Handled') }),
	Schema.Struct({
		_tag: Schema.Literal('HandledWithOutputFailure'),
		error: Schema.String,
	}),
	Schema.Struct({
		_tag: Schema.Literal('PermanentInvalid'),
		reason: Schema.String,
	}),
]);

export const JobOutcome = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal('Succeeded') }),
	Schema.Struct({
		_tag: Schema.Literal('RetryableFailure'),
		error: Schema.Unknown,
		retryAfter: Schema.optionalKey(DurationMillis),
	}),
	Schema.Struct({
		_tag: Schema.Literal('PermanentFailure'),
		error: Schema.Unknown,
	}),
	Schema.Struct({ _tag: Schema.Literal('FatalFailure'), cause: Schema.String }),
	Schema.Struct({ _tag: Schema.Literal('Cancelled') }),
	Schema.Struct({ _tag: Schema.Literal('LeaseLost') }),
]);

export const decode = <A, E>(
	schema: Schema.Schema<A>,
	value: unknown,
	error: (cause: unknown) => E,
): Effect.Effect<A, E> =>
	// Schema's abstract service parameter is unknown; concrete row codecs above
	// are service-free, so isolate that limitation at this runtime decode boundary.
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(error),
	) as Effect.Effect<A, E>;

export const expectOne = <A, E>(
	rows: ReadonlyArray<A>,
	error: () => E,
): Effect.Effect<A, E> => {
	const row = rows.at(0);
	return rows.length === 1 && row !== undefined
		? Effect.succeed(row)
		: Effect.fail(error());
};

export const safeInteger = <E>(
	value: string | number,
	error: () => E,
): Effect.Effect<number, E> => {
	const decoded = typeof value === 'number' ? value : Number(value);
	return Number.isSafeInteger(decoded)
		? Effect.succeed(decoded)
		: Effect.fail(error());
};

export const safeCause = (
	cause: unknown,
): Readonly<Record<string, unknown>> => {
	if (typeof cause === 'object' && cause !== null) {
		const candidate = cause as {
			readonly name?: unknown;
			readonly code?: unknown;
		};
		return Object.freeze({
			...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
			...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
		});
	}
	return Object.freeze({});
};

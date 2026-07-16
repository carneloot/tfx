import type * as Duration from 'effect/Duration';

export type JobOutcome<E = unknown> =
	| { readonly _tag: 'Succeeded' }
	| {
			readonly _tag: 'RetryableFailure';
			readonly error: E;
			readonly retryAfter?: Duration.Duration;
	  }
	| { readonly _tag: 'PermanentFailure'; readonly error: E }
	| { readonly _tag: 'FatalFailure'; readonly cause: string }
	| { readonly _tag: 'Cancelled' }
	| { readonly _tag: 'LeaseLost' };
export const succeeded: JobOutcome<never> = Object.freeze({
	_tag: 'Succeeded',
});
export const retryableFailure = <E>(
	error: E,
	retryAfter?: Duration.Duration,
): JobOutcome<E> =>
	Object.freeze({
		_tag: 'RetryableFailure',
		error,
		...(retryAfter === undefined ? {} : { retryAfter }),
	});
export const permanentFailure = <E>(error: E): JobOutcome<E> =>
	Object.freeze({ _tag: 'PermanentFailure', error });
export const fatalFailure = (cause: unknown): JobOutcome<never> =>
	Object.freeze({
		_tag: 'FatalFailure',
		cause:
			cause instanceof Error
				? `${cause.name}: ${cause.message}`
				: String(cause),
	});
export const cancelled: JobOutcome<never> = Object.freeze({
	_tag: 'Cancelled',
});
export const leaseLost: JobOutcome<never> = Object.freeze({
	_tag: 'LeaseLost',
});

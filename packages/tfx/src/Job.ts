import type * as Effect from 'effect/Effect';

import type * as VersionedSchema from './VersionedSchema.js';
export type RetryDecision =
	| { readonly _tag: 'Retry'; readonly retryAfter?: number }
	| { readonly _tag: 'Permanent' };
export interface Job<Name extends string, Payload, Error> {
	readonly _tag: 'Job';
	readonly name: Name;
	readonly payload: VersionedSchema.History<any>;
	readonly maxAttempts: number;
	readonly retry: (error: Error) => RetryDecision | undefined;
	readonly schedule: (attempt: number) => number;
	readonly _Payload: Payload;
	readonly _Error: Error;
}
export interface Options<H extends VersionedSchema.History<any>, Error> {
	readonly payload: H;
	readonly error?: Error;
	readonly maxAttempts: number;
	readonly retry: (error: Error) => RetryDecision | undefined;
	readonly schedule?: (attempt: number) => number;
}
export const make = <
	const Name extends string,
	H extends VersionedSchema.History<any>,
	Error = never,
>(
	name: Name,
	options: Options<H, Error>,
): Job<Name, VersionedSchema.Latest<H>, Error> => {
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0)
		throw new Error('maxAttempts must be positive');
	return Object.freeze({
		_tag: 'Job',
		name,
		payload: options.payload,
		maxAttempts: options.maxAttempts,
		retry: options.retry,
		schedule:
			options.schedule ??
			((attempt) => Math.min(60_000, 1000 * 2 ** (attempt - 1))),
		_Payload: undefined as never,
		_Error: undefined as never,
	});
};
export type Payload<J> = J extends Job<any, infer A, any> ? A : never;
export type Error<J> = J extends Job<any, any, infer E> ? E : never;
export interface Implementation<J extends Job<any, any, any>, R> {
	readonly declaration: J;
	readonly handler: (payload: Payload<J>) => Effect.Effect<void, Error<J>, R>;
	readonly _R: R;
}
export const implement = <J extends Job<any, any, any>, R>(
	declaration: J,
	handler: (payload: Payload<J>) => Effect.Effect<void, Error<J>, R>,
): Implementation<J, R> =>
	Object.freeze({ declaration, handler, _R: undefined as R });
export const retry = (retryAfter?: number): RetryDecision =>
	Object.freeze({
		_tag: 'Retry',
		...(retryAfter === undefined ? {} : { retryAfter }),
	});
export const permanent: RetryDecision = Object.freeze({ _tag: 'Permanent' });

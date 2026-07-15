import * as Schema from 'effect/Schema';

import type { TaggedError } from './TaggedError.js';
export type { TaggedError } from './TaggedError.js';

export type ErrorSchema = Schema.Top;

type IsAny<A> = 0 extends 1 & A ? true : false;
type IsNever<A> = [A] extends [never] ? true : false;
type IsVoid<A> =
	IsAny<A> extends true
		? false
		: [A] extends [void]
			? [void] extends [A]
				? true
				: false
			: false;

export type ErrorOf<S extends ErrorSchema> =
	IsVoid<Schema.Schema.Type<S>> extends true
		? never
		: IsAny<Schema.Schema.Type<S>> extends true
			? never
			: IsNever<Schema.Schema.Type<S>> extends true
				? never
				: Schema.Schema.Type<S> extends TaggedError
					? Schema.Schema.Type<S>
					: never;

export type Valid<S extends ErrorSchema> =
	IsVoid<Schema.Schema.Type<S>> extends true
		? S
		: IsAny<Schema.Schema.Type<S>> extends true
			? never
			: IsNever<Schema.Schema.Type<S>> extends true
				? never
				: Schema.Schema.Type<S> extends TaggedError
					? S
					: never;

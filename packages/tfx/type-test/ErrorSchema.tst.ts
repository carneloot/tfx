import * as Schema from 'effect/Schema';

import type * as ErrorSchema from '../src/ErrorSchema.js';

type Assert<T extends true> = T;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

class FirstError extends Schema.TaggedErrorClass<FirstError>()(
	'FirstError',
	{},
) {}
class SecondError extends Schema.TaggedErrorClass<SecondError>()(
	'SecondError',
	{ message: Schema.String },
) {}
const Errors = Schema.Union([FirstError, SecondError]);

export type VoidHasNoError = Assert<
	Equal<ErrorSchema.ErrorOf<typeof Schema.Void>, never>
>;
export type TaggedClassRetainsError = Assert<
	Equal<ErrorSchema.ErrorOf<typeof FirstError>, FirstError>
>;
export type TaggedUnionRetainsErrors = Assert<
	Equal<ErrorSchema.ErrorOf<typeof Errors>, FirstError | SecondError>
>;
export type VoidIsValid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.Void>, typeof Schema.Void>
>;
export type StringIsInvalid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.String>, never>
>;
export type UnknownIsInvalid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.Unknown>, never>
>;
export type AnyIsInvalid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.Any>, never>
>;
export type NeverIsInvalid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.Never>, never>
>;
export type UndefinedIsInvalid = Assert<
	Equal<ErrorSchema.Valid<typeof Schema.Undefined>, never>
>;

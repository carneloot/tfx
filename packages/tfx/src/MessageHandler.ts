import type * as ErrorSchema from './ErrorSchema.js';
import type * as MessageInput from './MessageInput.js';
import type * as Middleware from './Middleware.js';

export interface MessageHandler<
	Id extends string,
	Input extends MessageInput.MessageInput<any, any>,
	ES extends ErrorSchema.ErrorSchema,
	Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> = readonly [],
> {
	readonly _tag: 'MessageHandler';
	readonly id: Id;
	readonly input: Input;
	readonly error: ES;
	readonly middleware: Middlewares;
}
export const make = <
	const Id extends string,
	Input extends MessageInput.MessageInput<any, any>,
	ES extends ErrorSchema.ErrorSchema,
	const Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> =
		readonly [],
>(
	id: Id,
	options: {
		readonly input: Input;
		readonly error: ErrorSchema.Valid<ES>;
		readonly middleware?: Middlewares;
	},
): MessageHandler<Id, Input, ES, Middlewares> =>
	Object.freeze({
		_tag: 'MessageHandler',
		id,
		input: options.input,
		error: options.error,
		middleware: Object.freeze([
			...(options.middleware ?? []),
		]) as unknown as Middlewares,
	});
export type Error<H> =
	H extends MessageHandler<any, any, infer ES, any>
		? ErrorSchema.ErrorOf<ES>
		: never;

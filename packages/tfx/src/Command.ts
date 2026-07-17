import type * as CommandInput from './CommandInput.js';
import { none } from './CommandInput.js';
import type * as ErrorSchema from './ErrorSchema.js';
import { MessageContext } from './MessageContext.js';
import type * as Middleware from './Middleware.js';
import { UpdateContext } from './UpdateContext.js';

type BuiltIn = UpdateContext | MessageContext;
type AnyCommandInput = CommandInput.CommandInput<any, any, any, any, any>;

export interface Command<
	Id extends string,
	Input extends AnyCommandInput,
	ES extends ErrorSchema.ErrorSchema,
	Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> = readonly [],
> {
	readonly _tag: 'Command';
	readonly id: Id;
	readonly name: string;
	readonly aliases: ReadonlyArray<string>;
	readonly input: Input;
	readonly error: ES;
	readonly description: string | undefined;
	readonly language: string | undefined;
	/** Ordered request middleware metadata. Implementations live in a separate Pipeline/Layer. */
	readonly middleware: Middlewares;
}

export interface Options<
	Input extends AnyCommandInput,
	ES extends ErrorSchema.ErrorSchema,
	Middlewares extends ReadonlyArray<Middleware.AnyMiddleware>,
> {
	readonly name: string;
	readonly aliases?: ReadonlyArray<string>;
	readonly input?: Input;
	readonly error: ES;
	readonly description?: string;
	readonly language?: string;
	readonly middleware?: Middlewares;
}

const scopeRank: Record<Middleware.Scope, number> = {
	global: 0,
	group: 1,
	command: 2,
	conversation: 2,
	handler: 3,
};
export const make = <
	const Id extends string,
	ES extends ErrorSchema.ErrorSchema,
	Input extends AnyCommandInput = typeof none,
	const Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> =
		readonly [],
>(
	id: Id,
	options: Options<Input, ES, Middlewares> & {
		readonly error: ErrorSchema.Valid<ES>;
	} & (Middleware.ValidOrder<Middlewares, BuiltIn> extends true
			? unknown
			: { readonly middleware: never }),
): Command<Id, Input, ES, Middlewares> => {
	const middleware = [...(options.middleware ?? [])] as Middlewares[number][];
	const aliases = Object.freeze([...(options.aliases ?? [])]);
	const available = new Set<unknown>([UpdateContext, MessageContext]);
	let rank = -1;
	for (const item of middleware) {
		if (scopeRank[item.scope] < rank)
			throw new Error(`Middleware '${item.id}' is out of scope order`);
		for (const required of item.requires)
			if (!available.has(required))
				throw new Error(
					`Middleware '${item.id}' requires an unavailable request service`,
				);
		rank = scopeRank[item.scope];
		available.add(item.provides);
	}
	return Object.freeze({
		_tag: 'Command' as const,
		id,
		name: options.name,
		aliases,
		input: options.input ?? (none as unknown as Input),
		error: options.error,
		description: options.description,
		language: options.language,
		middleware: Object.freeze(middleware) as unknown as Middlewares,
	});
};
export type Error<C> =
	C extends Command<any, any, infer ES, any> ? ErrorSchema.ErrorOf<ES> : never;

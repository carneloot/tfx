import type * as Effect from 'effect/Effect';

import type * as Conversation from './Conversation.js';
import type * as ConversationInput from './ConversationInput.js';
import type * as Transition from './internal/conversation/Transition.js';
import type * as Middleware from './Middleware.js';
import type { TaggedError } from './TaggedError.js';
import type * as UpdateContext from './UpdateContext.js';
export {
	to,
	stay,
	complete,
	cancelled,
} from './internal/conversation/Transition.js';
export type {
	AfterCommit,
	Transition,
} from './internal/conversation/Transition.js';

type StepsOf<C> =
	C extends Conversation.Conversation<any, any, infer S, any, any, any>
		? S
		: never;
type ErrorOf<C> = Conversation.ErrorOf<C>;
type ProvidedBy<C> =
	C extends Conversation.Conversation<any, any, any, any, any, infer M>
		? Middleware.ProvidedBy<M>
		: never;
type AnyTransition<
	S extends Readonly<Record<string, Conversation.AnyStep>>,
	E extends TaggedError = TaggedError,
> =
	| {
			[K in keyof S & string]: Transition.Transition<
				K,
				Conversation.StateOf<S[K]>,
				E,
				any
			>;
	  }[keyof S & string]
	| Transition.Transition<never, never, E, any>;
// Contextualize targets without widening afterCommit services; validate full results after inference.
type TransitionTarget<
	S extends Readonly<Record<string, Conversation.AnyStep>>,
> =
	| (Conversation.Persisted<S> & { readonly _tag: 'To' })
	| { readonly _tag: 'Stay' | 'Complete' | 'Cancelled' };
type ValidatedHandlers<
	H,
	S extends Readonly<Record<string, Conversation.AnyStep>>,
	E extends TaggedError,
> = {
	[K in keyof H]: K extends 'onInput' | 'onInvalid'
		? NonNullable<H[K]> extends (
				...args: any[]
			) => Effect.Effect<AnyTransition<S, E>, E, any>
			? H[K]
			: never
		: H[K];
};
export interface StepHandlers<
	S extends Conversation.AnyStep,
	Steps extends Readonly<Record<string, Conversation.AnyStep>>,
	E extends TaggedError,
	R,
	Available = any,
	Result = AnyTransition<Steps, E>,
> {
	readonly enter: (
		state: Conversation.StateOf<S>,
	) => Effect.Effect<void, E, R | Available>;
	readonly onInput: (
		state: Conversation.StateOf<S>,
		input: Conversation.InputOf<S>,
	) => Effect.Effect<Result, E, R | Available>;
	readonly onInvalid?: (
		state: Conversation.StateOf<S>,
		error: unknown,
	) => Effect.Effect<Result, E, R | Available>;
}
export type AnyStepHandlers = StepHandlers<
	Conversation.Step<
		string,
		any,
		ConversationInput.ConversationInput<any, any, any>
	>,
	any,
	any,
	any
>;
type HandlerRequirements<H> = {
	[K in keyof H]-?: NonNullable<H[K]> extends (
		...args: any[]
	) => Effect.Effect<infer A, any, infer R>
		?
				| R
				| (A extends {
						readonly afterCommit?: Effect.Effect<void, any, infer O>;
				  }
						? O
						: never)
		: never;
}[keyof H];
export interface Builder<
	C extends Conversation.Conversation<any, any, any, any, any, any>,
	Remaining extends keyof StepsOf<C>,
	R,
	Implementations extends Readonly<Record<string, AnyStepHandlers>>,
> {
	readonly declaration: C;
	readonly implementations: Implementations;
	readonly _remaining: Remaining;
	readonly _requirements: R;
	step<
		const Id extends Remaining,
		const H extends StepHandlers<
			StepsOf<C>[Id],
			StepsOf<C>,
			ErrorOf<C>,
			any,
			any,
			TransitionTarget<StepsOf<C>>
		>,
	>(
		id: Id,
		handlers: H & NoInfer<ValidatedHandlers<H, StepsOf<C>, ErrorOf<C>>>,
	): Builder<
		C,
		Exclude<Remaining, Id>,
		| R
		| Exclude<
				HandlerRequirements<H>,
				| ConversationInput.ContextService<StepsOf<C>[Id]['input']>
				| UpdateContext.UpdateContext
				| ProvidedBy<C>
		  >
		| ConversationInput.Requirements<StepsOf<C>[Id]['input']>,
		Implementations & { readonly [K in Id]: H }
	>;
}
const build = <
	C extends Conversation.Conversation<any, any, any, any, any, any>,
	Remaining extends keyof StepsOf<C>,
	R,
	I extends Readonly<Record<string, AnyStepHandlers>>,
>(
	declaration: C,
	implementations: I,
): Builder<C, Remaining, R, I> => ({
	declaration,
	implementations,
	_remaining: undefined as never,
	_requirements: undefined as never,
	step(id, handlers) {
		if (Object.hasOwn(implementations, id))
			throw new Error(`Duplicate conversation step '${String(id)}'`);
		return build(
			declaration,
			Object.freeze({ ...implementations, [id]: handlers }),
		) as never;
	},
});
export const make = <
	C extends Conversation.Conversation<any, any, any, any, any, any>,
>(
	declaration: C,
): Builder<C, keyof StepsOf<C>, never, {}> => build(declaration, {});
export const done = <
	C extends Conversation.Conversation<any, any, any, any, any, any>,
	R,
	I extends Readonly<Record<string, AnyStepHandlers>>,
>(
	builder: Builder<C, never, R, I>,
) =>
	Object.freeze({
		declaration: builder.declaration,
		implementations: builder.implementations,
		_requirements: undefined as R,
	});

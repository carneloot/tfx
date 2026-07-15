import type * as Effect from 'effect/Effect';

import type { TaggedError } from '../../TaggedError.js';
export type AfterCommit<
	E extends TaggedError = TaggedError,
	R = any,
> = Effect.Effect<void, E, R>;
export type Transition<
	Step extends string = string,
	State = unknown,
	E extends TaggedError = TaggedError,
	R = any,
> =
	| {
			readonly _tag: 'To';
			readonly step: Step;
			readonly state: State;
			readonly afterCommit?: AfterCommit<E, R>;
	  }
	| { readonly _tag: 'Stay'; readonly afterCommit?: AfterCommit<E, R> }
	| { readonly _tag: 'Complete'; readonly afterCommit?: AfterCommit<E, R> }
	| { readonly _tag: 'Cancelled'; readonly afterCommit?: AfterCommit<E, R> };
export const to = <
	const Step extends string,
	State,
	E extends TaggedError = never,
	R = never,
>(
	step: Step,
	state: State,
	options: { readonly afterCommit?: AfterCommit<E, R> } = {},
): Transition<Step, State, E, R> =>
	Object.freeze({ _tag: 'To', step, state, ...options });
export const stay = <E extends TaggedError = never, R = never>(
	options: { readonly afterCommit?: AfterCommit<E, R> } = {},
): Transition<never, never, E, R> =>
	Object.freeze({ _tag: 'Stay', ...options });
export const complete = <E extends TaggedError = never, R = never>(
	options: { readonly afterCommit?: AfterCommit<E, R> } = {},
): Transition<never, never, E, R> =>
	Object.freeze({ _tag: 'Complete', ...options });
export const cancelled = <E extends TaggedError = never, R = never>(
	options: { readonly afterCommit?: AfterCommit<E, R> } = {},
): Transition<never, never, E, R> =>
	Object.freeze({ _tag: 'Cancelled', ...options });

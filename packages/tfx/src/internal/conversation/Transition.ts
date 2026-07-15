import type * as Effect from 'effect/Effect';
export type AfterCommit = Effect.Effect<void, unknown, unknown>;
export type Transition<Step extends string = string, State = unknown> =
	| {
			readonly _tag: 'To';
			readonly step: Step;
			readonly state: State;
			readonly afterCommit?: AfterCommit;
	  }
	| { readonly _tag: 'Stay'; readonly afterCommit?: AfterCommit }
	| { readonly _tag: 'Complete'; readonly afterCommit?: AfterCommit }
	| { readonly _tag: 'Cancelled'; readonly afterCommit?: AfterCommit };
export const to = <const Step extends string, State>(
	step: Step,
	state: State,
	options: { readonly afterCommit?: AfterCommit } = {},
): Transition<Step, State> =>
	Object.freeze({ _tag: 'To', step, state, ...options });
export const stay = (
	options: { readonly afterCommit?: AfterCommit } = {},
): Transition<never, never> => Object.freeze({ _tag: 'Stay', ...options });
export const complete = (
	options: { readonly afterCommit?: AfterCommit } = {},
): Transition<never, never> => Object.freeze({ _tag: 'Complete', ...options });
export const cancelled = (
	options: { readonly afterCommit?: AfterCommit } = {},
): Transition<never, never> => Object.freeze({ _tag: 'Cancelled', ...options });

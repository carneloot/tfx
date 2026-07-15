export type DispatchOutcome =
	| { readonly _tag: 'Handled' }
	| { readonly _tag: 'HandledWithOutputFailure'; readonly error: string }
	| { readonly _tag: 'PermanentInvalid'; readonly reason: string }
	| { readonly _tag: 'RetryableFailure'; readonly error: string }
	| { readonly _tag: 'Fatal'; readonly cause: string };
export type CompletedOutcome = Extract<
	DispatchOutcome,
	{ readonly _tag: 'Handled' | 'HandledWithOutputFailure' | 'PermanentInvalid' }
>;
export const handled: CompletedOutcome = Object.freeze({ _tag: 'Handled' });
export const handledWithOutputFailure = (error: unknown): CompletedOutcome =>
	Object.freeze({ _tag: 'HandledWithOutputFailure', error: String(error) });
export const permanentInvalid = (reason: string): CompletedOutcome =>
	Object.freeze({ _tag: 'PermanentInvalid', reason });
export const retryableFailure = (error: unknown): DispatchOutcome =>
	Object.freeze({ _tag: 'RetryableFailure', error: String(error) });
export const fatal = (cause: unknown): DispatchOutcome =>
	Object.freeze({ _tag: 'Fatal', cause: String(cause) });

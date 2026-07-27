export type MessageHandlerResult =
	| { readonly _tag: 'Handled' }
	| { readonly _tag: 'Unmatched' };
export const handled: MessageHandlerResult = Object.freeze({ _tag: 'Handled' });
export const unmatched: MessageHandlerResult = Object.freeze({
	_tag: 'Unmatched',
});

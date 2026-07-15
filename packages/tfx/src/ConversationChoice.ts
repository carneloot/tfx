import * as Effect from 'effect/Effect';

import type * as CallbackData from './CallbackData.js';
export type ChoiceResult<A> =
	| { readonly _tag: 'Selected'; readonly value: A }
	| { readonly _tag: 'Cancelled' };
export interface Option<A> {
	readonly label: string;
	readonly value: A;
}
export interface Choice<A, R> {
	readonly options: ReadonlyArray<Option<A>>;
	readonly callbackData:
		| CallbackData.CallbackData<A, any, any, any>
		| undefined;
	readonly cancelLabel: string | undefined;
	readonly columns: number;
	readonly _R: R;
}
export class ConversationChoiceError extends Error {
	readonly _tag = 'ConversationChoiceError';
	constructor(
		readonly reason:
			| 'EmptyChoiceOptions'
			| 'DuplicateLabel'
			| 'DuplicateValue'
			| 'InvalidResponse',
		message: string,
	) {
		super(message);
	}
}
export const make = <
	A,
	C extends CallbackData.CallbackData<A, any, any, any> | undefined = undefined,
>(
	options: ReadonlyArray<Option<A>>,
	config: {
		readonly callbackData?: C;
		readonly cancelLabel?: string;
		readonly columns?: number;
	} = {},
): Choice<
	A,
	C extends CallbackData.CallbackData<any, any, any, any>
		? CallbackData.Services<C>
		: never
> => {
	if (options.length === 0)
		throw new ConversationChoiceError(
			'EmptyChoiceOptions',
			'Choice options cannot be empty',
		);
	const labels = new Set<string>();
	for (const option of options) {
		if (labels.has(option.label) || option.label === config.cancelLabel)
			throw new ConversationChoiceError(
				'DuplicateLabel',
				`Duplicate choice label '${option.label}'`,
			);
		labels.add(option.label);
	}
	if ((config.columns ?? 1) <= 0)
		throw new ConversationChoiceError(
			'InvalidResponse',
			'Choice columns must be positive',
		);
	return Object.freeze({
		options: Object.freeze(options.map((o) => Object.freeze({ ...o }))),
		callbackData: config.callbackData,
		cancelLabel: config.cancelLabel,
		columns: config.columns ?? 1,
		_R: undefined as never,
	});
};
export const selected = <A>(value: A): ChoiceResult<A> =>
	Object.freeze({ _tag: 'Selected', value });
export const cancelled: ChoiceResult<never> = Object.freeze({
	_tag: 'Cancelled',
});
export const encodeValues = <A, R>(
	choice: Choice<A, R>,
): Effect.Effect<
	ReadonlyArray<string>,
	ConversationChoiceError | unknown,
	R
> => {
	if (choice.callbackData === undefined)
		return Effect.succeed(choice.options.map((o) => o.label)) as never;
	return Effect.flatMap(
		Effect.forEach(choice.options, (o) => choice.callbackData!.encode(o.value)),
		(values) =>
			new Set(values).size === values.length
				? Effect.succeed(values)
				: Effect.fail(
						new ConversationChoiceError(
							'DuplicateValue',
							'Choice callback values must be unique',
						),
					),
	) as never;
};
export const rows = <A, R>(
	choice: Choice<A, R>,
	values: ReadonlyArray<string>,
): ReadonlyArray<
	ReadonlyArray<{ readonly label: string; readonly value: string }>
> =>
	Object.freeze(
		Array.from(
			{ length: Math.ceil(choice.options.length / choice.columns) },
			(_, row) =>
				Object.freeze(
					choice.options
						.slice(row * choice.columns, (row + 1) * choice.columns)
						.map((option, i) =>
							Object.freeze({
								label: option.label,
								value: values[row * choice.columns + i]!,
							}),
						),
				),
		),
	);

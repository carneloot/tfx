import * as Effect from 'effect/Effect';
import type * as Schema from 'effect/Schema';

import type * as CallbackData from './CallbackData.js';
import * as ConversationChoice from './ConversationChoice.js';
import * as InlineKeyboard from './InlineKeyboard.js';
import * as ReplyKeyboard from './ReplyKeyboard.js';

export const choice = <A, R>(declaration: ConversationChoice.Choice<A, R>) =>
	Effect.map(ConversationChoice.encodeValues(declaration), (values) =>
		declaration.callbackData === undefined
			? ReplyKeyboard.rows(
					ConversationChoice.rows(declaration, values).map((row) =>
						row.map((item) => item.label),
					),
					{ oneTime: true, resize: true },
				)
			: InlineKeyboard.rows(
					ConversationChoice.rows(declaration, values).map((row) =>
						row.map((item) => InlineKeyboard.callback(item.label, item.value)),
					),
				),
	);

export const resolve = <A, R, AE = never, AR = never>(
	declaration: ConversationChoice.Choice<A, R>,
	response: string,
	options: { readonly acknowledge?: Effect.Effect<void, AE, AR> } = {},
): Effect.Effect<
	ConversationChoice.ChoiceResult<A>,
	| ConversationChoice.ConversationChoiceError
	| CallbackData.CallbackDataError
	| Schema.SchemaError
	| AE,
	R | AR
> => {
	if (response === declaration.cancelLabel)
		return Effect.as(
			options.acknowledge ?? Effect.void,
			ConversationChoice.cancelled,
		) as never;
	if (declaration.callbackData === undefined) {
		const option = declaration.options.find((item) => item.label === response);
		return option === undefined
			? Effect.fail(
					new ConversationChoice.ConversationChoiceError(
						'InvalidResponse',
						'Unknown choice response',
					),
				)
			: Effect.succeed(ConversationChoice.selected(option.value));
	}
	return Effect.flatMap(declaration.callbackData.decode(response), (value) =>
		Effect.as(
			options.acknowledge ?? Effect.void,
			ConversationChoice.selected(value),
		),
	) as never;
};

export const removeReplyKeyboard = Object.freeze({
	remove_keyboard: true as const,
});

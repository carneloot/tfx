import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import type * as CallbackData from './CallbackData.js';
import { CallbackQueryContext } from './CallbackQueryContext.js';
import type * as CommandInput from './CommandInput.js';
import type * as ConversationChoice from './ConversationChoice.js';
import * as ConversationPrompt from './ConversationPrompt.js';
import * as CommandParser from './internal/bot/CommandParser.js';
import { MessageContext } from './MessageContext.js';

export interface ConversationInput<A, R, Context> {
	readonly _tag: 'Text' | 'Callback' | 'Reaction' | 'Command';
	readonly _A: A;
	readonly _R: R;
	readonly _Context: Context;
}
export type Decoded<I> =
	I extends ConversationInput<infer A, any, any> ? A : never;
export type Requirements<I> =
	I extends ConversationInput<any, infer R, any> ? R : never;
export type ContextService<I> =
	I extends ConversationInput<any, any, infer C> ? C : never;
type StringCodec = Schema.ConstraintCodec<any, string, any, any>;
export const text = <S extends StringCodec>(
	schema: S,
): ConversationInput<S['Type'], S['DecodingServices'], MessageContext> & {
	readonly schema: S;
} =>
	Object.freeze({
		_tag: 'Text',
		schema,
		_A: undefined as never,
		_R: undefined as never,
		_Context: undefined as never,
	});
export const callback = <
	C extends CallbackData.CallbackData<any, any, any, any>,
>(
	codec: C,
): ConversationInput<
	CallbackData.Decoded<C>,
	CallbackData.Services<C>,
	CallbackQueryContext
> & { readonly codec: C } =>
	Object.freeze({
		_tag: 'Callback',
		codec,
		_A: undefined as never,
		_R: undefined as never,
		_Context: undefined as never,
	});
export const choice = <A, R>(
	value: ConversationChoice.Choice<A, R>,
): ConversationInput<
	ConversationChoice.ChoiceResult<A>,
	R,
	CallbackQueryContext | MessageContext
> & { readonly choice: ConversationChoice.Choice<A, R> } =>
	Object.freeze({
		_tag: 'Callback',
		choice: value,
		_A: undefined as never,
		_R: undefined as never,
		_Context: undefined as never,
	});
export type Reaction = ReadonlyArray<{
	readonly type: string;
	readonly emoji?: string;
}>;
export const reaction: ConversationInput<Reaction, never, MessageContext> =
	Object.freeze({
		_tag: 'Reaction',
		_A: undefined as never,
		_R: undefined as never,
		_Context: undefined as never,
	});
export const command = <
	I extends CommandInput.CommandInput<any, any, any, any, any>,
>(
	input: I,
): ConversationInput<
	CommandInput.Decoded<I>,
	CommandInput.Requirements<I>,
	MessageContext
> & { readonly input: I } =>
	Object.freeze({
		_tag: 'Command',
		input,
		_A: undefined as never,
		_R: undefined as never,
		_Context: undefined as never,
	});

type RuntimeInput = ConversationInput<any, any, any> & {
	readonly schema?: Schema.Schema<any>;
	readonly codec?: CallbackData.CallbackData<any, any, any, any>;
	readonly choice?: ConversationChoice.Choice<any, any>;
	readonly input?: CommandInput.CommandInput<any, any, any, any, any>;
};

/** Decode a raw update value according to a declared conversation input. */
export const decode = <I extends ConversationInput<any, any, any>>(
	input: I,
	raw: unknown,
): Effect.Effect<Decoded<I>, unknown, Requirements<I>> => {
	const value = input as RuntimeInput;
	switch (value._tag) {
		case 'Text':
			return Schema.decodeUnknownEffect(value.schema!)(raw) as never;
		case 'Callback':
			if (typeof raw !== 'string')
				return Effect.fail(new TypeError('Callback input must be a string'));
			return (
				value.choice === undefined
					? value.codec!.decode(raw)
					: ConversationPrompt.resolve(value.choice, raw)
			) as never;
		case 'Command':
			if (typeof raw !== 'string')
				return Effect.fail(new TypeError('Command input must be a string'));
			return CommandParser.parse(value.input!, raw) as never;
		case 'Reaction':
			return Array.isArray(raw) &&
				raw.every(
					(item) =>
						typeof item === 'object' &&
						item !== null &&
						typeof (item as { type?: unknown }).type === 'string',
				)
				? Effect.succeed(raw as Decoded<I>)
				: Effect.fail(new TypeError('Reaction input must be a reaction array'));
	}
};

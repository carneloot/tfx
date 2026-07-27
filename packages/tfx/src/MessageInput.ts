import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import type { Update } from './internal/telegram/generated/TelegramApi.types.js';

export const TypeId: unique symbol = Symbol.for('tfx/MessageInput');
export interface MessageInput<out A, out R = never> {
	readonly [TypeId]: { readonly decoded: A; readonly requirements: R };
	readonly _tag: 'Text' | 'ReplyText';
	readonly schema: any;
}
export type Decoded<I> = I extends MessageInput<infer A, any> ? A : never;
export type Requirements<I> = I extends MessageInput<any, infer R> ? R : never;
type StringSchema = Schema.ConstraintCodec<any, string, any, any>;
const make = <A, R>(tag: MessageInput<A, R>['_tag'], schema: any) =>
	Object.freeze({
		[TypeId]: undefined as never,
		_tag: tag,
		schema,
	}) as MessageInput<A, R>;
export const text = <S extends StringSchema>(
	codec: S,
): MessageInput<S['Type'], S['DecodingServices']> => make('Text', codec);
export const replyText = <S extends StringSchema>(
	codec: S,
): MessageInput<
	{ readonly text: S['Type']; readonly repliedMessageId: number },
	S['DecodingServices']
> => make('ReplyText', codec);
export const decode = <A, R>(
	input: MessageInput<A, R>,
	update: Update,
): Effect.Effect<A, Schema.SchemaError, R> | undefined => {
	const message = (update as any).message;
	if (message === undefined || typeof message.text !== 'string')
		return undefined;
	const decoded = Schema.decodeUnknownEffect(input.schema)(
		message.text,
	) as Effect.Effect<any, Schema.SchemaError, R>;
	if (input._tag === 'Text') return decoded;
	const repliedMessageId = message.reply_to_message?.message_id;
	if (!Number.isSafeInteger(repliedMessageId) || repliedMessageId <= 0)
		return undefined;
	return Effect.map(decoded, (text) =>
		Object.freeze({ text, repliedMessageId }),
	) as Effect.Effect<A, Schema.SchemaError, R>;
};

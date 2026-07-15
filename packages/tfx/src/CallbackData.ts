import { Effect, Schema } from 'effect';

const TypeId: unique symbol = Symbol.for('tfx/CallbackData');
const separator = ':';

export type Encoded = string & { readonly CallbackData: unique symbol };

export class CallbackDataError extends Error {
	readonly _tag = 'CallbackDataError';
	constructor(
		readonly reason:
			| 'InvalidNamespace'
			| 'NamespaceMismatch'
			| 'MalformedPayload'
			| 'ByteLimit',
		message: string,
	) {
		super(message);
	}
}

export interface CallbackData<
	A,
	out RD = never,
	out RE = never,
	out Namespace extends string = string,
> {
	readonly [TypeId]: typeof TypeId;
	readonly namespace: Namespace;
	readonly codec: Schema.ConstraintCodec<A, string, RD, RE>;
	readonly encode: (
		value: A,
	) => Effect.Effect<Encoded, Schema.SchemaError | CallbackDataError, RE>;
	readonly decode: (
		value: string,
	) => Effect.Effect<A, Schema.SchemaError | CallbackDataError, RD>;
}

export type Decoded<T> = T extends CallbackData<infer A, any, any> ? A : never;
export type DecodingServices<T> =
	T extends CallbackData<any, infer R, any> ? R : never;
export type EncodingServices<T> =
	T extends CallbackData<any, any, infer R> ? R : never;
export type Services<T> = DecodingServices<T> | EncodingServices<T>;

const byteLength = (value: string): number =>
	new TextEncoder().encode(value).byteLength;

export const make = <const Namespace extends string, A, RD, RE>(
	namespace: Namespace,
	codec: Schema.ConstraintCodec<A, string, RD, RE>,
): CallbackData<A, RD, RE, Namespace> => {
	if (namespace.length === 0 || namespace.includes(separator)) {
		throw new CallbackDataError(
			'InvalidNamespace',
			`Invalid callback namespace '${namespace}'`,
		);
	}
	const encode = (value: A) =>
		Schema.encodeEffect(codec)(value).pipe(
			Effect.flatMap((payload) => {
				const encoded = `${namespace}${separator}${payload}`;
				const bytes = byteLength(encoded);
				return bytes >= 1 && bytes <= 64
					? Effect.succeed(encoded as Encoded)
					: Effect.fail(
							new CallbackDataError(
								'ByteLimit',
								`Callback data must be 1-64 UTF-8 bytes; received ${bytes}`,
							),
						);
			}),
		);
	const decode = (value: string) => {
		const bytes = byteLength(value);
		if (bytes < 1 || bytes > 64)
			return Effect.fail(
				new CallbackDataError(
					'ByteLimit',
					`Callback data must be 1-64 UTF-8 bytes; received ${bytes}`,
				),
			);
		const split = value.indexOf(separator);
		if (split < 1) {
			return Effect.fail(
				new CallbackDataError('MalformedPayload', 'Malformed callback data'),
			);
		}
		if (value.slice(0, split) !== namespace) {
			return Effect.fail(
				new CallbackDataError(
					'NamespaceMismatch',
					`Expected callback namespace '${namespace}'`,
				),
			);
		}
		return Schema.decodeEffect(codec)(value.slice(split + 1));
	};
	return Object.freeze({
		[TypeId]: TypeId,
		namespace,
		codec,
		encode,
		decode,
	}) as CallbackData<A, RD, RE, Namespace>;
};

type NamespaceOf<C> =
	C extends CallbackData<any, any, any, infer N> ? N : never;
type Unique<
	C extends ReadonlyArray<CallbackData<any, any, any, any>>,
	Seen extends string = never,
> = C extends readonly [
	infer H extends CallbackData<any, any, any, any>,
	...infer T extends ReadonlyArray<CallbackData<any, any, any, any>>,
]
	? NamespaceOf<H> extends Seen
		? false
		: Unique<T, Seen | NamespaceOf<H>>
	: true;

/** Validates a statically assembled set and returns an immutable namespace lookup. */
export const registry = <
	const C extends ReadonlyArray<CallbackData<any, any, any, any>>,
>(
	...codecs: C &
		(Unique<C> extends true ? unknown : ['Duplicate callback namespace'])
) => {
	const values: Record<string, C[number]> = Object.create(null);
	for (const codec of codecs) {
		if (values[codec.namespace] !== undefined) {
			throw new CallbackDataError(
				'InvalidNamespace',
				`Duplicate callback namespace '${codec.namespace}'`,
			);
		}
		values[codec.namespace] = codec;
	}
	return Object.freeze(values) as Readonly<
		Record<NamespaceOf<C[number]>, C[number]>
	>;
};

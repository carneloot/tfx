import * as Effect from 'effect/Effect';
import type * as Schema from 'effect/Schema';

import {
	CommandInputError,
	decode,
	type CommandInput,
	type Decoded,
	type Requirements,
	type RuntimeInput,
} from '../../CommandInput.js';

export interface MessageEntity {
	readonly type: string;
	readonly offset: number;
	readonly length: number;
}

export interface CommandMessage {
	readonly text?: string;
	readonly entities?: ReadonlyArray<MessageEntity>;
}

/** Returns command arguments only when Telegram marked an offset-zero command entity. */
export const matchCommand = (
	message: CommandMessage,
	commandName: string,
	botUsername: string,
): string | undefined => {
	const text = message.text;
	const entity = message.entities?.find(
		(entity) => entity.type === 'bot_command' && entity.offset === 0,
	);
	if (text === undefined || entity === undefined) return undefined;
	const token = text.slice(0, entity.length);
	const match = /^\/([^@\s]+)(?:@([^\s]+))?$/.exec(token);
	if (match === null || match[1] !== commandName) return undefined;
	if (
		match[2] !== undefined &&
		match[2].toLocaleLowerCase('en-US') !==
			botUsername.replace(/^@/, '').toLocaleLowerCase('en-US')
	)
		return undefined;
	return text.slice(entity.length);
};

interface Cursor {
	readonly source: string;
	offset: number;
}
const skipWhitespace = (cursor: Cursor): void => {
	while (
		cursor.offset < cursor.source.length &&
		/\s/u.test(cursor.source[cursor.offset]!)
	)
		cursor.offset++;
};
const token = (cursor: Cursor): string | undefined => {
	skipWhitespace(cursor);
	if (cursor.offset === cursor.source.length) return undefined;
	const start = cursor.offset;
	while (
		cursor.offset < cursor.source.length &&
		!/\s/u.test(cursor.source[cursor.offset]!)
	)
		cursor.offset++;
	return cursor.source.slice(start, cursor.offset);
};
const remainder = (cursor: Cursor): string | undefined => {
	skipWhitespace(cursor);
	if (cursor.offset === cursor.source.length) return undefined;
	const value = cursor.source.slice(cursor.offset).trimEnd();
	cursor.offset = cursor.source.length;
	return value;
};

const missing = (input: RuntimeInput) =>
	Effect.fail(
		new CommandInputError(
			'MissingInput',
			`Missing command argument '${input.name ?? 'input'}'`,
		),
	);

const parseNode = (
	input: RuntimeInput,
	cursor: Cursor,
): Effect.Effect<any, Schema.SchemaError | CommandInputError, any> => {
	switch (input._tag) {
		case 'None':
			return Effect.succeed({});
		case 'Argument': {
			const value = token(cursor);
			return value === undefined
				? missing(input)
				: Effect.map(decode(input.schema!, value), (decoded) => ({
						[input.name!]: decoded,
					}));
		}
		case 'Rest': {
			const value = remainder(cursor);
			return value === undefined
				? missing(input)
				: Effect.map(decode(input.schema!, value), (decoded) => ({
						[input.name!]: decoded,
					}));
		}
		case 'Repeated': {
			const parts: Array<Record<string, unknown>> = [];
			const loop = (): Effect.Effect<
				Record<string, ReadonlyArray<unknown>>,
				Schema.SchemaError | CommandInputError,
				any
			> => {
				skipWhitespace(cursor);
				if (cursor.offset === cursor.source.length) {
					if (parts.length === 0) return missing(input.input!);
					const result: Record<string, Array<unknown>> = {};
					for (const part of parts)
						for (const [name, value] of Object.entries(part))
							(result[name] ??= []).push(value);
					return Effect.succeed(result);
				}
				const before = cursor.offset;
				return Effect.gen(function* () {
					const part = yield* parseNode(input.input!, cursor);
					if (cursor.offset === before)
						return yield* Effect.fail(
							new CommandInputError(
								'InvalidSequence',
								'Repeated input did not consume command text',
							),
						);
					parts.push(part);
					return yield* loop();
				});
			};
			return loop();
		}
		case 'Optional': {
			const before = cursor.offset;
			skipWhitespace(cursor);
			if (cursor.offset === cursor.source.length) return Effect.succeed({});
			cursor.offset = before;
			return parseNode(input.input!, cursor);
		}
		case 'Sequence':
			return Effect.map(
				Effect.forEach(input.inputs!, (part) => parseNode(part, cursor)),
				(parts) => Object.assign({}, ...parts),
			);
		case 'Map':
			return Effect.map(parseNode(input.input!, cursor), input.map!);
	}
};

export const parse = <I extends CommandInput<any, any, any, any, any>>(
	input: I,
	source: string,
): Effect.Effect<
	Decoded<I>,
	Schema.SchemaError | CommandInputError,
	Requirements<I>
> =>
	Effect.gen(function* () {
		const cursor: Cursor = { source, offset: 0 };
		const value = yield* parseNode(input as RuntimeInput, cursor);
		skipWhitespace(cursor);
		if (cursor.offset !== source.length)
			return yield* Effect.fail(
				new CommandInputError(
					'UnexpectedInput',
					`Unexpected command input '${source.slice(cursor.offset)}'`,
				),
			);
		return value;
	}) as never;

export const parseCommand = <I extends CommandInput<any, any, any, any, any>>(
	input: I,
	message: CommandMessage,
	commandName: string,
	botUsername: string,
): Effect.Effect<
	Decoded<I> | undefined,
	Schema.SchemaError | CommandInputError,
	Requirements<I>
> => {
	const source = matchCommand(message, commandName, botUsername);
	return source === undefined
		? Effect.succeed(undefined)
		: parse(input, source);
};

import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { decode, type CommandInput, type Decoded, type Requirements, type RuntimeInput } from "../../CommandInput.js"

export interface MessageEntity {
  readonly type: string
  readonly offset: number
  readonly length: number
}

export interface CommandMessage {
  readonly text?: string
  readonly entities?: ReadonlyArray<MessageEntity>
}

/** Returns command arguments only when Telegram marked an offset-zero command entity. */
export const matchCommand = (
  message: CommandMessage,
  commandName: string,
  botUsername: string
): string | undefined => {
  const text = message.text
  const entity = message.entities?.find((entity) => entity.type === "bot_command" && entity.offset === 0)
  if (text === undefined || entity === undefined) return undefined
  const token = text.slice(0, entity.length)
  const match = /^\/([^@\s]+)(?:@([^\s]+))?$/.exec(token)
  if (match === null || match[1] !== commandName) return undefined
  if (match[2] !== undefined && match[2].toLocaleLowerCase("en-US") !== botUsername.replace(/^@/, "").toLocaleLowerCase("en-US")) return undefined
  return text.slice(entity.length)
}

interface Cursor { readonly source: string; offset: number }
const skipWhitespace = (cursor: Cursor): void => {
  while (cursor.offset < cursor.source.length && /\s/u.test(cursor.source[cursor.offset]!)) cursor.offset++
}
const token = (cursor: Cursor): string | undefined => {
  skipWhitespace(cursor)
  if (cursor.offset === cursor.source.length) return undefined
  const start = cursor.offset
  while (cursor.offset < cursor.source.length && !/\s/u.test(cursor.source[cursor.offset]!)) cursor.offset++
  return cursor.source.slice(start, cursor.offset)
}
const remainder = (cursor: Cursor): string | undefined => {
  skipWhitespace(cursor)
  if (cursor.offset === cursor.source.length) return undefined
  const value = cursor.source.slice(cursor.offset).trimEnd()
  cursor.offset = cursor.source.length
  return value
}

const parseNode = (input: RuntimeInput, cursor: Cursor): Effect.Effect<any, Schema.SchemaError, any> => {
  switch (input._tag) {
    case "None": return Effect.succeed({})
    case "Argument": {
      const value = token(cursor)
      return value === undefined
        ? Effect.die(new Error(`Missing command argument '${input.name}'`))
        : Effect.map(decode(input.schema!, value), (decoded) => ({ [input.name!]: decoded }))
    }
    case "Rest": {
      const value = remainder(cursor)
      return value === undefined
        ? Effect.die(new Error(`Missing command argument '${input.name}'`))
        : Effect.map(decode(input.schema!, value), (decoded) => ({ [input.name!]: decoded }))
    }
    case "Repeated": {
      const values: Array<string> = []
      let value: string | undefined
      while ((value = token(cursor)) !== undefined) values.push(value)
      if (values.length === 0) return Effect.die(new Error(`Missing command argument '${input.name}'`))
      return Effect.map(Effect.all(values.map((value) => decode(input.schema!, value))), (decoded) => ({ [input.name!]: decoded }))
    }
    case "Optional": {
      const before = cursor.offset
      skipWhitespace(cursor)
      if (cursor.offset === cursor.source.length) return Effect.succeed({})
      cursor.offset = before
      return parseNode(input.input!, cursor)
    }
    case "Sequence":
      return Effect.map(Effect.forEach(input.inputs!, (part) => parseNode(part, cursor)), (parts) => Object.assign({}, ...parts))
    case "Map": return Effect.map(parseNode(input.input!, cursor), input.map!)
  }
}

export const parse = <I extends CommandInput<any, any, any, any, any>>(
  input: I,
  source: string
): Effect.Effect<Decoded<I>, Schema.SchemaError, Requirements<I>> =>
  parseNode(input as RuntimeInput, { source, offset: 0 })

export const parseCommand = <I extends CommandInput<any, any, any, any, any>>(
  input: I,
  message: CommandMessage,
  commandName: string,
  botUsername: string
): Effect.Effect<Decoded<I> | undefined, Schema.SchemaError, Requirements<I>> => {
  const source = matchCommand(message, commandName, botUsername)
  return source === undefined ? Effect.succeed(undefined) : parse(input, source)
}

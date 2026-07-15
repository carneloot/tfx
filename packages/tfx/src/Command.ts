import type * as CommandInput from "./CommandInput.js"
import { none } from "./CommandInput.js"

export type UpdateKind = "message" | "callback_query" | "inline_query"

export interface Command<Id extends string, Input extends CommandInput.CommandInput<any, any>, Error> {
  readonly _tag: "Command"
  readonly id: Id
  readonly name: string
  readonly input: Input
  readonly error: Error | undefined
  readonly description: string | undefined
  readonly language: string | undefined
  readonly updateKinds: ReadonlyArray<UpdateKind>
}

export interface Options<Input extends CommandInput.CommandInput<any, any>, Error> {
  readonly name: string
  readonly input?: Input
  /** Type witness for failures permitted from this command's handler. */
  readonly error?: Error
  readonly description?: string
  readonly language?: string
  readonly updateKinds?: ReadonlyArray<UpdateKind>
}

export const make = <const Id extends string, Input extends CommandInput.CommandInput<any, any> = typeof none, Error = never>(
  id: Id,
  options: Options<Input, Error>
): Command<Id, Input, Error> => Object.freeze({
  _tag: "Command" as const,
  id,
  name: options.name,
  input: options.input ?? none as unknown as Input,
  error: options.error,
  description: options.description,
  language: options.language,
  updateKinds: Object.freeze([...(options.updateKinds ?? ["message"])]),
})

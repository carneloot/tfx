import type * as Schema from "effect/Schema"
import * as CommandInput from "../../src/CommandInput.js"

interface DecodeService { readonly decode: "DecodeService" }
interface EncodeService { readonly encode: "EncodeService" }
declare const serviced: Schema.ConstraintCodec<number, string, DecodeService, EncodeService>
declare const numberEncoded: Schema.ConstraintCodec<string, number>

const value = CommandInput.sequence(
  CommandInput.argument("amount", serviced),
  CommandInput.optional(CommandInput.rest("note", {} as Schema.ConstraintCodec<string, string>))
)
type Output = CommandInput.Decoded<typeof value>
type Requirement = CommandInput.Requirements<typeof value>
const output: Output = { amount: 1 }
const requirement: Requirement = {} as DecodeService
void output
void requirement

// Encoding services must not become parsing requirements.
const noEncodingRequirement: CommandInput.Requirements<ReturnType<typeof CommandInput.argument<"x", typeof serviced>>> = {} as DecodeService
void noEncodingRequirement

// @ts-expect-error command arguments must be encoded as strings
CommandInput.argument("bad", numberEncoded)

// @ts-expect-error duplicate names
CommandInput.sequence(CommandInput.argument("x", serviced), CommandInput.argument("x", serviced))

// @ts-expect-error required input cannot follow optional input
CommandInput.sequence(CommandInput.optional(CommandInput.argument("x", serviced)), CommandInput.argument("y", serviced))

// @ts-expect-error input cannot follow rest
CommandInput.sequence(CommandInput.rest("x", serviced), CommandInput.argument("y", serviced))

// @ts-expect-error multiple rest inputs
CommandInput.sequence(CommandInput.rest("x", serviced), CommandInput.rest("y", serviced))

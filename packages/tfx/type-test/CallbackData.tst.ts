import { Effect, Schema } from "effect"
import * as CallbackData from "../src/CallbackData.js"

declare const Decoding: unique symbol
declare const Encoding: unique symbol
type Decoding = typeof Decoding
type Encoding = typeof Encoding
declare const codec: Schema.ConstraintCodec<number, string, Decoding, Encoding>

const data = CallbackData.make("number", codec)
const encoded: Effect.Effect<CallbackData.Encoded, Schema.SchemaError | CallbackData.CallbackDataError, Encoding> = data.encode(1)
const decoded: Effect.Effect<number, Schema.SchemaError | CallbackData.CallbackDataError, Decoding> = data.decode("number:1")
void encoded
void decoded

// @ts-expect-error callback codecs must encode to strings
CallbackData.make("bad", Schema.Number)

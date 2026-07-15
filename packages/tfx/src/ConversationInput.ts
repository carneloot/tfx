import type * as Schema from "effect/Schema"
import type * as CommandInput from "./CommandInput.js"
import type * as CallbackData from "./CallbackData.js"
import { MessageContext } from "./MessageContext.js"
import { CallbackQueryContext } from "./CallbackQueryContext.js"

export interface ConversationInput<A, R, Context> { readonly _tag: "Text" | "Callback" | "Reaction" | "Command"; readonly _A: A; readonly _R: R; readonly _Context: Context }
export type Decoded<I> = I extends ConversationInput<infer A, any, any> ? A : never
export type Requirements<I> = I extends ConversationInput<any, infer R, any> ? R : never
export type ContextService<I> = I extends ConversationInput<any, any, infer C> ? C : never
type StringCodec = Schema.ConstraintCodec<any, string, any, any>
export const text = <S extends StringCodec>(schema: S): ConversationInput<S["Type"], S["DecodingServices"], MessageContext> & { readonly schema: S } => Object.freeze({ _tag: "Text", schema, _A: undefined as never, _R: undefined as never, _Context: undefined as never })
export const callback = <C extends CallbackData.CallbackData<any, any, any, any>>(codec: C): ConversationInput<CallbackData.Decoded<C>, CallbackData.Services<C>, CallbackQueryContext> & { readonly codec: C } => Object.freeze({ _tag: "Callback", codec, _A: undefined as never, _R: undefined as never, _Context: undefined as never })
export type Reaction = ReadonlyArray<{ readonly type: string; readonly emoji?: string }>
export const reaction: ConversationInput<Reaction, never, MessageContext> = Object.freeze({ _tag: "Reaction", _A: undefined as never, _R: undefined as never, _Context: undefined as never })
export const command = <I extends CommandInput.CommandInput<any, any>>(input: I): ConversationInput<CommandInput.Decoded<I>, CommandInput.Requirements<I>, MessageContext> & { readonly input: I } => Object.freeze({ _tag: "Command", input, _A: undefined as never, _R: undefined as never, _Context: undefined as never })

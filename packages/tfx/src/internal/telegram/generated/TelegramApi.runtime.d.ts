// generated runtime bridge; do not edit
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import type { TelegramApi, BotCommand as BotCommandType, Message as MessageType, Update as UpdateType, User as UserType } from "./TelegramApi.types.js"
export declare const make: (client: HttpClient.HttpClient, options?: { readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined }) => TelegramApi
export declare const BotCommand: Schema.Codec<BotCommandType>
export declare const Message: Schema.Codec<MessageType>
export declare const Update: Schema.Codec<UpdateType>
export declare const User: Schema.Codec<UserType>

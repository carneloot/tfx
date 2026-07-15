// generated runtime bridge; do not edit
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import type { TelegramApi, BotCommand as BotCommandType, Message as MessageType, Update as UpdateType, User as UserType } from "./TelegramApi.types.js"
export declare const make: (client: HttpClient.HttpClient, options?: { readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined }) => TelegramApi
export declare const BotCommand: Schema.Schema<BotCommandType>
export declare const Message: Schema.Schema<MessageType>
export declare const Update: Schema.Schema<UpdateType>
export declare const User: Schema.Schema<UserType>

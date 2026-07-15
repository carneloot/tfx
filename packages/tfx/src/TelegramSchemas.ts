import * as Schema from "effect/Schema"

export const BotCommand = Schema.Struct({ command: Schema.String, description: Schema.String })
export type BotCommand = typeof BotCommand.Type

export const User = Schema.Struct({
  id: Schema.Number,
  is_bot: Schema.Boolean,
  first_name: Schema.String,
  username: Schema.optionalKey(Schema.String)
})
export type User = typeof User.Type

export const Message = Schema.Struct({
  message_id: Schema.Number,
  date: Schema.optionalKey(Schema.Number),
  chat: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  text: Schema.optionalKey(Schema.String)
})
export type Message = typeof Message.Type

export const Update = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optionalKey(Message)
})
export type Update = typeof Update.Type

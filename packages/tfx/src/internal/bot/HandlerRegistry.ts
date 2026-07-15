import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Middleware from "../../Middleware.js"

export interface HandlerEntry {
  readonly groupId: string
  readonly commandId: string
  readonly middleware: ReadonlyArray<Middleware.AnyMiddleware>
  readonly handler: (input: any) => Effect.Effect<any, any, any>
}

export class HandlerRegistry extends Context.Service<HandlerRegistry, ReadonlyArray<HandlerEntry>>()(
  "tfx/internal/bot/HandlerRegistry"
) {}

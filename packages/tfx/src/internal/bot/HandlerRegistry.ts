import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

export interface HandlerEntry {
  readonly groupId: string
  readonly commandId: string
  readonly handler: (input: any) => Effect.Effect<any, any, any>
}

export class HandlerRegistry extends Context.Service<HandlerRegistry, ReadonlyArray<HandlerEntry>>()(
  "tfx/internal/bot/HandlerRegistry"
) {}

import { Context, Effect, Layer } from "effect"
import type { Update } from "@effect-ak/tg-bot-api"
import type { BotContext } from "./BotContext"

/**
 * Result of middleware processing
 */
export type MiddlewareResult<T> =
  | { readonly _tag: "success"; readonly value: T }
  | { readonly _tag: "failure"; readonly error: Error }

/**
 * Base class for middleware definitions
 * Similar to HttpApiMiddleware in @effect/platform
 */
export abstract class Middleware<Success, Failure> extends Context.Tag<any>()(
  "Middleware"
) {
  /**
   * Process an update through the middleware
   * Returns success value that gets added to context, or failure
   */
  abstract process(input: {
    ctx: BotContext
    update: Update
  }): Effect.Effect<Success, Failure>
}

/**
 * Create a middleware layer
 * @param middleware The middleware class
 * @param impl Implementation of the middleware
 */
export const makeMiddlewareLayer = <Success, Failure>(
  middleware: { new (): any },
  impl: (input: {
    ctx: BotContext
    update: Update
  }) => Effect.Effect<Success, Failure>
): Layer.Layer<any> => {
  return Layer.effect(middleware as any, Effect.succeed(impl))
}

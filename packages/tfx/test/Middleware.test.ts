import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Middleware from "../src/Middleware.js"

class CurrentUser extends Context.Service<CurrentUser, { readonly id: number }>()("test/CurrentUser") {}
class CurrentAdmin extends Context.Service<CurrentAdmin, { readonly id: number }>()("test/CurrentAdmin") {}
class UserRepository extends Context.Service<UserRepository, { readonly find: () => number }>()("test/UserRepository") {}

const RegisteredUser = Middleware.make("registered-user", {
  scope: "global",
  provides: CurrentUser
})
const RequireAdmin = Middleware.make("require-admin", {
  scope: "group",
  provides: CurrentAdmin,
  requires: [CurrentUser]
})

describe("Middleware", () => {
  it("runs in scope order and exposes earlier request services", async () => {
    const order: Array<string> = []
    const registeredLive = Middleware.implement(RegisteredUser,
      Effect.gen(function*() {
        const repository = yield* UserRepository
        order.push("global")
        return { id: repository.find() }
      }))
    const adminLive = Middleware.implement(RequireAdmin,
      Effect.gen(function*() {
        const user = yield* CurrentUser
        order.push(`group:${user.id}`)
        return { id: user.id }
      }))
    const program = Middleware.empty
      .use(registeredLive)
      .use(adminLive)
      .run(Effect.gen(function*() {
        const admin = yield* CurrentAdmin
        order.push(`handler:${admin.id}`)
      }))

    await Effect.runPromise(Effect.provideService(program, UserRepository, { find: () => 42 }))
    expect(order).toEqual(["global", "group:42", "handler:42"])
  })

  it("builds a registry bridge that captures infrastructure and provides request services", async () => {
    const registeredLive = Middleware.implement(RegisteredUser,
      Effect.map(UserRepository, (repository) => ({ id: repository.find() })))
    const program = Effect.flatMap(Middleware.MiddlewareRegistry, (registry) =>
      registry.run([RegisteredUser.id], Effect.map(CurrentUser, (user) => user.id))) as Effect.Effect<number, unknown, Middleware.MiddlewareRegistry>
    const withRegistry = Effect.provide(program, Middleware.layer(registeredLive))
    await expect(Effect.runPromise(Effect.provideService(withRegistry, UserRepository, { find: () => 42 }))).resolves.toBe(42)
  })

  it("keeps pipelines immutable and rejects scope reversal", () => {
    const handler = Middleware.make("handler", { scope: "handler", provides: CurrentUser })
    const global = Middleware.make("global", { scope: "global", provides: CurrentAdmin })
    const first = Middleware.empty.use(Middleware.implement(handler, Effect.succeed({ id: 1 })))
    expect(Middleware.empty.applications).toEqual([])
    expect(() => first.use(Middleware.implement(global, Effect.succeed({ id: 1 })))).toThrow("cannot follow")
  })
})

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Middleware from "../src/Middleware.js"

class CurrentUser extends Context.Service<CurrentUser, { readonly id: number }>()("types/CurrentUser") {}
class CurrentAdmin extends Context.Service<CurrentAdmin, { readonly id: number }>()("types/CurrentAdmin") {}
class UserRepository extends Context.Service<UserRepository, { readonly find: () => number }>()("types/UserRepository") {}
class Result extends Context.Service<Result, { readonly id: number }>()("types/Result") {}

type Unauthorized = { readonly _tag: "Unauthorized" }

const RegisteredUser = Middleware.make("registered-user", {
  scope: "global",
  provides: CurrentUser,
  error: undefined as unknown as Unauthorized
})
const RequireAdmin = Middleware.make("require-admin", {
  scope: "group",
  provides: CurrentAdmin,
  requires: [CurrentUser],
  error: undefined as unknown as Unauthorized
})

const registeredLive = Middleware.implement(RegisteredUser,
  Effect.map(UserRepository, (repository) => ({ id: repository.find() })))
const adminLive = Middleware.implement(RequireAdmin,
  Effect.map(CurrentUser, (user) => ({ id: user.id })))

const ordered = Middleware.empty.use(registeredLive).use(adminLive)
// @ts-expect-error CurrentUser must be provided by earlier middleware
Middleware.empty.use(adminLive)

const effect = ordered.run(Effect.map(CurrentAdmin, (admin) => ({ id: admin.id })))
const _infrastructure: Effect.Effect<{ readonly id: number }, Unauthorized, UserRepository> = effect

const layer = Layer.effect(Result, effect)
const _layerRequirement: Layer.Layer<Result, Unauthorized, UserRepository> = layer

Middleware.implement(RegisteredUser,
  // @ts-expect-error middleware processing error was not declared
  Effect.fail("unexpected"))

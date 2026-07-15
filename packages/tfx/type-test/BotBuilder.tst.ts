import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Bot, BotBuilder, BotGroup, CallbackQueryContext, Command, CommandInput, MessageContext, Middleware, UpdateContext } from "tfx"

class Infra extends Context.Service<Infra, { readonly value: string }>()("test/Infra") {}
class CurrentUser extends Context.Service<CurrentUser, { readonly id: number }>()("test/CurrentUser") {}
class CurrentAdmin extends Context.Service<CurrentAdmin, { readonly id: number }>()("test/CurrentAdmin") {}
type AuthError = { readonly _tag: "AuthError" }
const user = Middleware.make("user", { scope: "global", provides: CurrentUser, error: undefined as unknown as AuthError })
const admin = Middleware.make("admin", { scope: "command", provides: CurrentAdmin, requires: [CurrentUser] })
// @ts-expect-error CurrentUser is not available before user middleware
Command.make("invalid-order", { name: "invalid", middleware: [admin, user] })
// @ts-expect-error commands are always message handlers
Command.make("invalid-kind", { name: "invalid", updateKinds: ["callback_query"] })
type Allowed = { readonly _tag: "Allowed" }

const petInput = CommandInput.none as CommandInput.CommandInput<{ readonly name: string }>
const pets = BotGroup.make("pets")
  .add(Command.make("addPet", { name: "add_pet", input: petInput, error: undefined as unknown as Allowed, middleware: [user, admin] }))
  .add(Command.make("listPets", { name: "list_pets" }))
const app = Bot.make("App").add(pets)

const live = BotBuilder.group(app, "pets", (handlers) => handlers
  .handle("addPet", (input) => {
    const _inferred: string = input.name
    return Effect.all([Infra, UpdateContext.UpdateContext, MessageContext.MessageContext, CurrentUser, CurrentAdmin]).pipe(Effect.as(_inferred))
  })
  .handle("listPets", (_input) => Effect.as(CallbackQueryContext.CallbackQueryContext, undefined)))
const _requirements: Layer.Layer<any, never, Infra | Middleware.MiddlewareRegistry | CallbackQueryContext.CallbackQueryContext> = live
const plainGroup = BotGroup.make("plain").add(Command.make("ping", { name: "ping" }))
const plainBot = Bot.make("Plain").add(plainGroup)
const plainLive: Layer.Layer<any, never, never> = BotBuilder.group(plainBot, "plain", (handlers) => handlers.handle("ping", () => Effect.void))
void plainLive

declare const registry: Middleware.MiddlewareRegistryService
const typedEntries = BotBuilder.group(app, "pets", (handlers) => {
  const first = handlers.handle("addPet", () => Effect.fail({ _tag: "Allowed" } as Allowed))
  const invoked: Effect.Effect<never, Allowed | AuthError, never> = first._entries[0]!.invoke(registry, { name: "pet" })
  void invoked
  return first.handle("listPets", () => Effect.void)
})
void typedEntries

// @ts-expect-error unknown group
BotBuilder.group(app, "missing", (handlers) => handlers)
// @ts-expect-error missing listPets implementation
BotBuilder.group(app, "pets", (handlers) => handlers.handle("addPet", () => Effect.void))
BotBuilder.group(app, "pets", (handlers) => handlers
  .handle("addPet", () => Effect.void)
  // @ts-expect-error duplicate implementation
  .handle("addPet", () => Effect.void))
BotBuilder.group(app, "pets", (handlers) => handlers
  // @ts-expect-error unknown command
  .handle("removePet", () => Effect.void))
BotBuilder.group(app, "pets", (handlers) => handlers
  // @ts-expect-error undeclared handler error
  .handle("addPet", () => Effect.fail("bad"))
  .handle("listPets", () => Effect.void))

// @ts-expect-error duplicate command declaration
pets.add(Command.make("addPet", { name: "another" }))
// @ts-expect-error duplicate group declaration
app.add(pets)

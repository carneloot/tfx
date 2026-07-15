import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Bot, BotBuilder, BotGroup, Command, CommandInput } from "tfx"

class Infra extends Context.Service<Infra, { readonly value: string }>()("test/Infra") {}
type Allowed = { readonly _tag: "Allowed" }

const petInput = CommandInput.none as CommandInput.CommandInput<{ readonly name: string }>
const pets = BotGroup.make("pets")
  .add(Command.make("addPet", { name: "add_pet", input: petInput, error: undefined as unknown as Allowed }))
  .add(Command.make("listPets", { name: "list_pets" }))
const app = Bot.make("App").add(pets)

const live = BotBuilder.group(app, "pets", (handlers) => handlers
  .handle("addPet", (input) => {
    const _inferred: string = input.name
    return Effect.as(Infra, _inferred)
  })
  .handle("listPets", (_input) => Effect.void))
const _requirements: Layer.Layer<any, never, Infra> = live

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

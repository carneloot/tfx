import { describe, expect, it } from "vitest"
import { Bot, BotGroup, Command } from "tfx"

describe("Bot declarations", () => {
  it("are immutable and add returns a new declaration", () => {
    const empty = BotGroup.make("pets")
    const pets = empty.add(Command.make("add", { name: "add_pet" }))
    expect(Object.isFrozen(empty)).toBe(true)
    expect(Object.isFrozen(pets.commands)).toBe(true)
    expect(Object.keys(empty.commands)).toEqual([])
    expect(Object.keys(pets.commands)).toEqual(["add"])
  })

  it("rejects invalid Telegram command names with fragment context", () => {
    const fragment = BotGroup.make("pets").add(Command.make("add", { name: "Add-Pet" }))
    expect(() => Bot.make("App").add(fragment)).toThrow("fragment 'pets'")
  })

  it("rejects command-name collisions across fragments", () => {
    const pets = BotGroup.make("pets").add(Command.make("add", { name: "shared" }))
    const food = BotGroup.make("food").add(Command.make("add", { name: "shared" }))
    expect(() => Bot.make("App").add(pets).add(food)).toThrow("fragments 'pets' and 'food'")
  })

  it("rejects runtime-composed duplicate group ids", () => {
    const first = BotGroup.make("pets")
    const second = BotGroup.make("pets")
    expect(() => Bot.make("App").add(first).add(second as never)).toThrow("Duplicate group id 'pets'")
  })
})

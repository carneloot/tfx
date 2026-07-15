import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as CommandInput from "../src/CommandInput.js"
import { parse } from "../src/internal/bot/CommandParser.js"

describe("CommandInput", () => {
  it("parses none, argument, optional, repeated, sequence, rest, and map", async () => {
    expect(await Effect.runPromise(parse(CommandInput.none, "  "))).toEqual({})
    expect(await Effect.runPromise(parse(CommandInput.argument("amount", Schema.NumberFromString), " 12 "))).toEqual({ amount: 12 })

    const input = CommandInput.sequence(
      CommandInput.argument("amount", Schema.NumberFromString),
      CommandInput.optional(CommandInput.argument("unit", Schema.String)),
      CommandInput.optional(CommandInput.rest("note", Schema.String))
    )
    expect(await Effect.runPromise(parse(input, " 12 kg  preserve   these spaces "))).toEqual({
      amount: 12,
      unit: "kg",
      note: "preserve   these spaces"
    })
    expect(await Effect.runPromise(parse(input, "12"))).toEqual({ amount: 12 })

    expect(await Effect.runPromise(parse(CommandInput.repeated("ids", Schema.NumberFromString), "1  2 3"))).toEqual({ ids: [1, 2, 3] })
    expect(await Effect.runPromise(parse(CommandInput.map(CommandInput.argument("n", Schema.NumberFromString), ({ n }) => n * 2), "4"))).toBe(8)
  })

  it("fails schema decoding", async () => {
    await expect(Effect.runPromise(parse(CommandInput.argument("answer", Schema.Literal("yes")), "nope"))).rejects.toBeDefined()
  })
})

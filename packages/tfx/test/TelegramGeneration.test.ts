import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("Telegram generation", () => {
  it("matches pinned generated output", () => {
    expect(() => execFileSync("node", ["scripts/check-generated.ts"], { cwd: new URL("..", import.meta.url), stdio: "pipe" })).not.toThrow()
  }, 120_000)
})

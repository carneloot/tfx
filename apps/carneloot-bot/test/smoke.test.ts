import { describe, expect, it } from "vitest"
import { packageName } from "../src/main.js"

describe("Carneloot bot package", () => {
  it("loads", () => expect(packageName).toBe("carneloot-bot"))
})

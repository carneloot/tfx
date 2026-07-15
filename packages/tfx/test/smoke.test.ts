import { describe, expect, it } from "vitest"
import { packageName } from "../src/index.js"

describe("tfx package", () => {
  it("loads", () => expect(packageName).toBe("tfx"))
})

import { describe, expect, it } from "vitest"
import { packageName } from "@tfx/postgres"

describe("@tfx/postgres package", () => {
  it("loads", () => expect(packageName).toBe("@tfx/postgres"))
})

import { describe, expect, it } from "vitest"
import {
  assertPostgresIntegrationSuites,
  postgresIntegrationSuites
} from "../../../vitest.integration.config.js"

const expectedSuites = [
  "packages/postgres/test/Migrations.integration.test.ts",
  "packages/postgres/test/ConversationStorage.integration.test.ts",
  "packages/postgres/test/JobStore.integration.test.ts",
  "packages/postgres/test/Deduplicator.integration.test.ts",
  "packages/postgres/test/Layers.integration.test.ts"
]

describe("PostgreSQL integration collection", () => {
  it("keeps every required suite in the integration manifest", () => {
    expect(postgresIntegrationSuites).toEqual(expectedSuites)
  })

  it("fails activation when a required suite is absent", () => {
    const missing = expectedSuites[2]

    expect(() =>
      assertPostgresIntegrationSuites((path) => path !== missing)
    ).toThrow(`Missing required PostgreSQL integration suites:\n${missing}`)
  })

  it("accepts activation when every required suite exists", () => {
    expect(() => assertPostgresIntegrationSuites(() => true)).not.toThrow()
  })
})

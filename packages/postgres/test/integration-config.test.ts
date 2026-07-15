import { describe, expect, it } from "vitest"
import {
  assertPostgresIntegrationSuiteSetWhenPresent,
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

  it("does not require future suites before Plan 08 starts", () => {
    expect(() =>
      assertPostgresIntegrationSuiteSetWhenPresent(() => false)
    ).not.toThrow()
  })

  it("automatically requires the complete set once any suite exists", () => {
    const firstSuite = expectedSuites[0]

    expect(() =>
      assertPostgresIntegrationSuiteSetWhenPresent(
        (path) => path === firstSuite
      )
    ).toThrow("Missing required PostgreSQL integration suites:")
  })

  it("accepts the complete required suite set", () => {
    expect(() =>
      assertPostgresIntegrationSuiteSetWhenPresent(() => true)
    ).not.toThrow()
  })
})

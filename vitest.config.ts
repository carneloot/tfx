import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts"]
  }
})

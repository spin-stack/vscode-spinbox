import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Every file under src/, so one no unit test imports counts as uncovered rather than absent.
      include: ["src/**"],
      // json-summary is what CI's job summary reads (hack/coverage-summary.mjs); reportOnFailure
      // keeps a red suite from leaving it nothing to read.
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      // A floor below the 87.1% of statements measured on 2026-11-14. Raise it when the number has
      // moved up and stayed; never lower it to let a change through.
      thresholds: { statements: 85 },
    },
  },
})

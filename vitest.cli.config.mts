import { defineConfig } from "vitest/config"

// task test:cli: the tests against the real spin CLI that task package:spin pulls.
export default defineConfig({
  test: {
    include: ["test/cli/**/*.test.ts"],
  },
})

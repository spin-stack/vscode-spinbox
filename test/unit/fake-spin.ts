import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const FAKE_SPIN = fileURLToPath(new URL("../fake-spin/spin.cjs", import.meta.url))

export interface Ran {
  exit: number | null
  lines: unknown[]
  stderr: string
}

// Runs the fake spin with args and env, and parses each line of its stdout.
export function runFake(args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, [FAKE_SPIN, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  })
  const lines = r.stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as unknown)
  return { exit: r.status, lines, stderr: r.stderr }
}

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { documents } from "../../src/cli/documents"

export const FAKE_SPIN = fileURLToPath(new URL("../fake-spin/spin.cjs", import.meta.url))

export interface Ran {
  exit: number | null
  // The JSON documents of its stdout, as the extension reads them.
  docs: unknown[]
  stdout: string
  stderr: string
}

// Runs the fake spin with args and env, and reads its stdout into documents.
export function runFake(args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, [FAKE_SPIN, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  })
  return { exit: r.status, docs: documents(r.stdout), stdout: r.stdout, stderr: r.stderr }
}

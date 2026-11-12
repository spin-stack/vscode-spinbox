import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type CliError, ProcessSpinCli } from "../../src/cli/client"
import { type ConnectDeps, prepareConnection } from "../../src/remote/connect"
import { FAKE_SPIN } from "./fake-spin"

const COMMIT = "c".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
})

interface Seen {
  closed: number
  errors: unknown[]
  reported: string[]
  invocations(): string[][]
}

// setup runs the fake spin with env, and records what the UI was asked to do. answer is what the
// person does with a shown error: nothing, or run its retry, which the test arranges to succeed.
function setup(
  env: Record<string, string> = {},
  opts: { cancel?: boolean; retryWith?: Record<string, string> } = {},
): { deps: ConnectDeps; seen: Seen } {
  const log = join(mkdtempSync(join(tmpdir(), "connect-")), "log")
  writeFileSync(log, "")
  for (const [k, v] of Object.entries({ FAKE_SPIN_LOG: log, ...env })) {
    vi.stubEnv(k, v)
  }
  const seen: Seen = {
    closed: 0,
    errors: [],
    reported: [],
    invocations: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
  }
  const deps: ConnectDeps = {
    cli: new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} }),
    ui: {
      progress: (_title, task) => {
        const abort = new AbortController()
        if (opts.cancel === true) {
          setTimeout(() => abort.abort(), 50)
        }
        return task(abort.signal, (m) => seen.reported.push(m))
      },
      showCliError: async (error, retry) => {
        seen.errors.push(error)
        if (opts.retryWith !== undefined) {
          vi.unstubAllEnvs()
          for (const [k, v] of Object.entries({ FAKE_SPIN_LOG: log, ...opts.retryWith })) {
            vi.stubEnv(k, v)
          }
          await retry().catch(() => undefined)
        }
      },
      closeRemote: async () => {
        seen.closed++
      },
    },
    commit: async () => COMMIT,
    vscodeVersion: "1.146.0",
    trace: () => undefined,
  }
  return { deps, seen }
}

describe("prepareConnection", () => {
  it("starts the workspace with this VS Code's server before Remote-SSH connects", async () => {
    const { deps, seen } = setup()
    expect(await prepareConnection(deps, "ssh-remote", "ssh-remote+spin.my-ws")).toBe(true)
    expect(seen.invocations()).toEqual([
      [
        "code",
        "my-ws",
        "--no-open",
        "--vscode-commit",
        COMMIT,
        "--vscode-version",
        "1.146.0",
        "--start",
        "-o",
        "json",
      ],
    ])
    expect(seen.closed).toBe(0)
  })

  it.each([
    ["another host", "ssh-remote", "ssh-remote+devbox"],
    ["a local window", undefined, undefined],
    ["Spinbox Remote's authority, which resolves itself", "spin", "spin+my-ws"],
  ])("does nothing for %s", async (_what, remoteName, authority) => {
    const { deps, seen } = setup()
    expect(await prepareConnection(deps, remoteName, authority)).toBeUndefined()
    expect(seen.invocations()).toEqual([])
    expect(seen.closed).toBe(0)
  })

  it("shows a refusal with its action, then closes the remote", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "key_not_enrolled" })
    expect(await prepareConnection(deps, "ssh-remote", "ssh-remote+spin.my-ws")).toBe(false)
    expect(seen.errors).toHaveLength(1)
    expect((seen.errors[0] as CliError).code).toBe("key_not_enrolled")
    expect(seen.closed).toBe(1)
  })

  it("lets Remote-SSH go on when the error's retry succeeds", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "not_signed_in" }, { retryWith: {} })
    expect(await prepareConnection(deps, "ssh-remote", "ssh-remote+spin.my-ws")).toBe(true)
    expect(seen.invocations()).toHaveLength(2)
    expect(seen.closed).toBe(0)
  })

  it("closes the remote when the person cancels", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "connect-scenario-")), "scenario.json")
    writeFileSync(file, JSON.stringify({ code: { stdout: [{}], delayMs: 10_000 } }))
    const { deps, seen } = setup({ FAKE_SPIN_SCENARIO: file }, { cancel: true })
    expect(await prepareConnection(deps, "ssh-remote", "ssh-remote+spin.my-ws")).toBe(false)
    expect(seen.errors).toEqual([])
    expect(seen.closed).toBe(1)
  })
})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, ProcessSpinCli } from "../../src/cli/client"
import type { Workspace } from "../../src/cli/contract"
import { readCommit } from "../../src/open/editor"
import { type OpenDeps, openWorkspace, pickAndOpen } from "../../src/open/open"
import { FAKE_SPIN } from "./fake-spin"

const COMMIT = "a".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
})

interface Seen {
  opened: string[]
  cliErrors: { error: unknown; retry: () => Promise<void> }[]
  errors: string[]
  warnings: string[]
  reported: string[]
  picked: Workspace[][]
  invocations(): string[][]
}

// deps runs the fake spin with env set for the test, and records what the UI was asked to do. cancel aborts each
// progress as soon as it starts, as the notification's Cancel does.
function setup(
  env: Record<string, string> = {},
  opts: {
    cancel?: boolean
    pick?: (ws: Workspace[]) => Workspace | undefined
    spin?: boolean
  } = {},
): { deps: OpenDeps; seen: Seen } {
  const dir = mkdtempSync(join(tmpdir(), "open-"))
  const log = join(dir, "log")
  writeFileSync(log, "")
  const seen: Seen = {
    opened: [],
    cliErrors: [],
    errors: [],
    warnings: [],
    reported: [],
    picked: [],
    invocations: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
  }
  for (const [k, v] of Object.entries({ FAKE_SPIN_LOG: log, ...env })) {
    vi.stubEnv(k, v)
  }
  const deps: OpenDeps = {
    cli: new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} }),
    ui: {
      progress: (_title, task) => {
        const abort = new AbortController()
        const p = task(abort.signal, (message) => seen.reported.push(message))
        if (opts.cancel === true) {
          setTimeout(() => abort.abort(), 50)
        }
        return p
      },
      pick: async (ws) => {
        seen.picked.push(ws)
        return (opts.pick ?? ((w) => w[0]))(ws)
      },
      openFolder: async (uri) => {
        seen.opened.push(uri)
      },
      showCliError: (error, retry) => {
        seen.cliErrors.push({ error, retry })
      },
      showError: (message) => {
        seen.errors.push(message)
      },
      showWarning: (message) => {
        seen.warnings.push(message)
      },
    },
    commit: async () => COMMIT,
    vscodeVersion: "1.120.0",
    trace: () => undefined,
    spin: opts.spin === true,
  }
  return { deps, seen }
}

function scenario(answers: object): string {
  const file = join(mkdtempSync(join(tmpdir(), "open-scenario-")), "scenario.json")
  writeFileSync(file, JSON.stringify(answers))
  return file
}

describe("openWorkspace", () => {
  it("runs spin code and opens the folder it answers in a new window", async () => {
    const { deps, seen } = setup()
    await openWorkspace(deps, { workspace: "ws-1", path: "/root/src" })
    expect(seen.invocations()).toEqual([
      [
        "code",
        "ws-1",
        "/root/src",
        "--no-open",
        "--vscode-commit",
        COMMIT,
        "--vscode-version",
        "1.120.0",
        "--start",
        "-o",
        "json",
      ],
    ])
    expect(seen.opened).toEqual(["vscode-remote://ssh-remote+spin.my-ws/root"])
    expect(seen.cliErrors).toEqual([])
  })

  // The first workspace of the installation to ask for this VS Code waits while the installation
  // prepares its server, and the notification says each step.
  it("says each step of a server being prepared, then opens the folder", async () => {
    const step = (s: string) => ({
      preparing: { vscode_version: "1.120.0", vscode_commit: COMMIT, step: s },
    })
    const { deps, seen } = setup({
      FAKE_SPIN_SCENARIO: scenario({
        code: {
          stdout: [
            step("downloading"),
            step("building"),
            {
              workspace_id: "ws-1",
              host: "spin.my-ws",
              folder_uri: "vscode-remote://ssh-remote+spin.my-ws/root",
              server: "carried",
            },
          ],
        },
      }),
    })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.reported).toEqual([
      "Preparing VS Code 1.120.0 for this installation (once): downloading",
      "Preparing VS Code 1.120.0 for this installation (once): building",
    ])
    expect(seen.opened).toEqual(["vscode-remote://ssh-remote+spin.my-ws/root"])
    expect(seen.warnings).toEqual([])
  })

  // A server the installation would not prepare is said, beside the folder opening anyway: VS
  // Code downloads its own into the workspace.
  it("says why the installation gave no server, and opens the folder anyway", async () => {
    const why =
      "this installation downloads no VS Code server: an administrator accepts them in Admin → Extensions"
    const { deps, seen } = setup({
      FAKE_SPIN_SCENARIO: scenario({
        code: {
          stdout: [
            {
              workspace_id: "ws-1",
              host: "spin.my-ws",
              folder_uri: "vscode-remote://ssh-remote+spin.my-ws/root",
              server: "missing",
              not_given: why,
            },
          ],
        },
      }),
    })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.warnings).toHaveLength(1)
    expect(seen.warnings[0]).toContain(why)
    expect(seen.opened).toEqual(["vscode-remote://ssh-remote+spin.my-ws/root"])
  })

  it("through the resolver, runs the same spin code and opens its folder as spin+<workspace>", async () => {
    const { deps, seen } = setup({}, { spin: true })
    await openWorkspace(deps, { workspace: "ws-1", path: "/root/src" })
    expect(seen.invocations()).toEqual([
      [
        "code",
        "ws-1",
        "/root/src",
        "--no-open",
        "--vscode-commit",
        COMMIT,
        "--vscode-version",
        "1.120.0",
        "--start",
        "-o",
        "json",
      ],
    ])
    expect(seen.opened).toEqual(["vscode-remote://spin+my-ws/root"])
    expect(seen.errors).toEqual([])
  })

  // The resolver downloads no server: it refuses the workspace itself, saying what to do, so a
  // warning that VS Code downloads one would be untrue.
  it("through the resolver, does not say VS Code downloads a server", async () => {
    const { deps, seen } = setup(
      {
        FAKE_SPIN_SCENARIO: scenario({
          code: {
            stdout: [
              {
                workspace_id: "ws-1",
                host: "spin.my-ws",
                folder_uri: "vscode-remote://ssh-remote+spin.my-ws/root",
                server: "missing",
                not_given: "no server",
              },
            ],
          },
        }),
      },
      { spin: true },
    )
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.warnings).toEqual([])
    expect(seen.opened).toEqual(["vscode-remote://spin+my-ws/root"])
  })

  it("through the resolver, says so and opens nothing when spin names a host that is no workspace", async () => {
    const { deps, seen } = setup(
      {
        FAKE_SPIN_SCENARIO: scenario({
          code: {
            stdout: [
              {
                workspace_id: "ws-1",
                host: "devbox",
                folder_uri: "vscode-remote://ssh-remote+devbox/root",
                server: "carried",
              },
            ],
          },
        }),
      },
      { spin: true },
    )
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.opened).toEqual([])
    expect(seen.errors).toHaveLength(1)
    expect(seen.errors[0]).toContain("vscode-remote://ssh-remote+devbox/root")
  })

  it("hands a failure to the errors module with a retry that runs it again, and opens nothing", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "key_not_enrolled" })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.opened).toEqual([])
    expect(seen.cliErrors).toHaveLength(1)
    const [{ error, retry }] = seen.cliErrors as [Seen["cliErrors"][number]]
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("key_not_enrolled")
    await expect(retry()).rejects.toMatchObject({ code: "key_not_enrolled" })
    expect(seen.invocations()).toHaveLength(2)
    expect(seen.cliErrors).toHaveLength(1)
  })

  it("runs each attempt in a trace of its own", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "unreachable" })
    let n = 0
    deps.trace = () => `00-${String(++n).padStart(32, "0")}-${"1".repeat(16)}-01`
    await openWorkspace(deps, { workspace: "ws-1" })
    await expect(seen.cliErrors[0]?.retry()).rejects.toBeInstanceOf(CliError)
    const traceparents = seen.invocations().map((a) => a[a.indexOf("--traceparent") + 1])
    expect(traceparents).toEqual([
      `00-${"0".repeat(31)}1-${"1".repeat(16)}-01`,
      `00-${"0".repeat(31)}2-${"1".repeat(16)}-01`,
    ])
  })

  it("reads a failure without an envelope as internal, with what spin wrote on stderr", async () => {
    const file = scenario({ code: { stdout: [], stderr: "boom\n", exit: 3 } })
    const { deps, seen } = setup({ FAKE_SPIN_SCENARIO: file })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.opened).toEqual([])
    expect(seen.cliErrors).toHaveLength(1)
    const error = seen.cliErrors[0]?.error as CliError
    expect(error.code).toBe("internal")
    expect(error.message).toContain("boom")
  })

  it("shows nothing and opens nothing when the progress is cancelled", async () => {
    const file = scenario({ code: { stdout: [{ folder_uri: "x" }], delayMs: 10_000 } })
    const { deps, seen } = setup({ FAKE_SPIN_SCENARIO: file }, { cancel: true })
    const started = Date.now()
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(seen.opened).toEqual([])
    expect(seen.cliErrors).toEqual([])
  })

  it("refuses a workspace spin would read as a flag, without running it", async () => {
    const { deps, seen } = setup()
    await openWorkspace(deps, { workspace: "--endpoint=https://evil" })
    expect(seen.invocations()).toEqual([])
    expect(seen.errors).toEqual([expect.stringContaining("is not a workspace id")])
  })

  it("says so when this VS Code names no commit, without running spin", async () => {
    const { deps, seen } = setup()
    deps.commit = () => readCommit(mkdtempSync(join(tmpdir(), "approot-")))
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.invocations()).toEqual([])
    expect(seen.errors).toHaveLength(1)
  })
})

describe("pickAndOpen", () => {
  it("opens the workspace picked from the list", async () => {
    const { deps, seen } = setup()
    await pickAndOpen(deps)
    expect(seen.picked).toEqual([[expect.objectContaining({ id: "ws-1" })]])
    expect(seen.invocations().map((a) => a.slice(0, 2))).toEqual([
      ["workspace", "list"],
      ["code", "ws-1"],
    ])
    expect(seen.opened).toEqual(["vscode-remote://ssh-remote+spin.my-ws/root"])
  })

  it("runs nothing more when none is picked", async () => {
    const { deps, seen } = setup({}, { pick: () => undefined })
    await pickAndOpen(deps)
    expect(seen.invocations()).toHaveLength(1)
    expect(seen.opened).toEqual([])
  })

  it("hands a failed listing to the errors module", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "not_signed_in" })
    await pickAndOpen(deps)
    expect(seen.cliErrors.map((e) => (e.error as CliError).code)).toEqual(["not_signed_in"])
    expect(seen.picked).toEqual([])
  })

  it("opens the workspace it is named without listing", async () => {
    const { deps, seen } = setup()
    await pickAndOpen(deps, "ws-1")
    expect(seen.invocations().map((a) => a[0])).toEqual(["code"])
  })
})

describe("readCommit", () => {
  it("reads the commit from the appRoot's product.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "approot-"))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "product.json"), JSON.stringify({ commit: COMMIT }))
    expect(await readCommit(root)).toBe(COMMIT)
  })

  it("refuses a product.json whose commit is not 40 hex", async () => {
    const root = mkdtempSync(join(tmpdir(), "approot-"))
    writeFileSync(join(root, "product.json"), JSON.stringify({ commit: "main" }))
    await expect(readCommit(root)).rejects.toThrow("names no commit")
  })
})

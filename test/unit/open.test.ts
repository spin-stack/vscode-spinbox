import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CliError } from "../../src/cli/client"
import type { Workspace } from "../../src/cli/contract"
import { readCommit } from "../../src/open/editor"
import { type OpenDeps, openWorkspace, pickAndOpen } from "../../src/open/open"
import { spawnOpenCli } from "../../src/open/spawn"
import { FAKE_SPIN } from "./fake-spin"

const COMMIT = "a".repeat(40)

interface Seen {
  opened: string[]
  cliErrors: { error: unknown; retry: () => Promise<void> }[]
  errors: string[]
  picked: Workspace[][]
  invocations(): string[][]
}

// deps runs the fake spin with env, and records what the UI was asked to do. cancel aborts each
// progress as soon as it starts, as the notification's Cancel does.
function setup(
  env: Record<string, string> = {},
  opts: { cancel?: boolean; pick?: (ws: Workspace[]) => Workspace | undefined } = {},
): { deps: OpenDeps; seen: Seen } {
  const dir = mkdtempSync(join(tmpdir(), "open-"))
  const log = join(dir, "log")
  writeFileSync(log, "")
  const seen: Seen = {
    opened: [],
    cliErrors: [],
    errors: [],
    picked: [],
    invocations: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
  }
  const deps: OpenDeps = {
    cli: spawnOpenCli({
      file: process.execPath,
      args: [FAKE_SPIN],
      env: { PATH: process.env.PATH ?? "", FAKE_SPIN_LOG: log, ...env },
    }),
    ui: {
      progress: (_title, task) => {
        const abort = new AbortController()
        const p = task(abort.signal)
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
    },
    commit: async () => COMMIT,
    vscodeVersion: "1.120.0",
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

  it("hands a failure to the errors module with a retry that runs it again, and opens nothing", async () => {
    const { deps, seen } = setup({ FAKE_SPIN_ERROR: "access_needs_signature" })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.opened).toEqual([])
    expect(seen.cliErrors).toHaveLength(1)
    const [{ error, retry }] = seen.cliErrors as [Seen["cliErrors"][number]]
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("access_needs_signature")
    await retry()
    expect(seen.invocations()).toHaveLength(2)
  })

  it("reads a failure without an envelope as internal, with what spin wrote on stderr", async () => {
    const file = scenario({ code: { stdout: [], stderr: "boom\n", exit: 3 } })
    const { deps, seen } = setup({ FAKE_SPIN_SCENARIO: file })
    await openWorkspace(deps, { workspace: "ws-1" })
    expect(seen.opened).toEqual([])
    expect(seen.cliErrors).toHaveLength(1)
    const error = seen.cliErrors[0]?.error as CliError
    expect(error.code).toBe("internal")
    expect(error.message).toBe("boom")
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

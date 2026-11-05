import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProcessSpinCli } from "../../src/cli/client"
import { BUTTON, configureErrors } from "../../src/errors"
import {
  MENU,
  MENU_COMMAND,
  POLL_MS,
  RESUME,
  registerStatus,
  WorkspaceStatus,
} from "../../src/status"
import { FAKE_SPIN } from "./fake-spin"

const vs = vi.hoisted(() => ({
  item: { text: "", tooltip: "", show: vi.fn(), dispose: vi.fn() } as Record<string, unknown>,
  createStatusBarItem: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
  withProgress: vi.fn(),
  env: { remoteName: undefined as string | undefined },
  workspace: { workspaceFolders: undefined as unknown, workspaceFile: undefined as unknown },
}))

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: vs.createStatusBarItem,
    showWarningMessage: vs.showWarningMessage,
    showErrorMessage: vs.showErrorMessage,
    showInformationMessage: vs.showInformationMessage,
    showQuickPick: vs.showQuickPick,
    withProgress: vs.withProgress,
  },
  commands: { executeCommand: vs.executeCommand, registerCommand: vs.registerCommand },
  env: {
    get remoteName() {
      return vs.env.remoteName
    },
    appRoot: "/nonexistent",
    openExternal: vs.openExternal,
    clipboard: { writeText: vs.writeText },
  },
  workspace: vs.workspace,
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
  version: "1.120.0",
}))

const COMMIT = "a".repeat(40)
const REMOTE = { host: "spin.my-ws", workspace: "my-ws" }

let dir: string
let log: string

beforeEach(() => {
  vi.resetAllMocks()
  vs.item = { text: "", tooltip: "", show: vi.fn(), dispose: vi.fn() }
  vs.createStatusBarItem.mockImplementation(() => vs.item)
  vs.withProgress.mockImplementation(progress())
  vs.registerCommand.mockReturnValue({ dispose: () => {} })
  vs.env.remoteName = undefined
  vs.workspace.workspaceFolders = undefined
  configureErrors(undefined)
  dir = mkdtempSync(join(tmpdir(), "status-"))
  log = join(dir, "log")
  writeFileSync(log, "")
  vi.stubEnv("FAKE_SPIN_LOG", log)
  vi.stubEnv("FAKE_SPIN_SCENARIO", join(dir, "scenario.json"))
  answer("WORKSPACE_STATE_RUNNING")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// withProgress as VS Code runs it; cancel presses its Cancel once the task started.
function progress(cancel = false) {
  return (_o: unknown, task: (p: unknown, token: unknown) => Promise<unknown>) => {
    const fns: (() => void)[] = []
    const token = { onCancellationRequested: (fn: () => void) => fns.push(fn) }
    const p = task({}, token)
    if (cancel) {
      setTimeout(() => {
        for (const fn of fns) fn()
      }, 50)
    }
    return p
  }
}

// What spin workspace list answers from now on: my-ws in state, suspended when snapshot is set.
function answer(state: string, snapshot = ""): void {
  const ws = { id: "ws-1", name: "my-ws", state, suspendedSnapshotId: snapshot }
  writeFileSync(
    join(dir, "scenario.json"),
    JSON.stringify({ "workspace list": { stdout: [{ items: [ws] }] } }),
  )
}

function invocations(): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[])
}

function cli(): ProcessSpinCli {
  return new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} })
}

function status(): WorkspaceStatus {
  return new WorkspaceStatus(cli(), REMOTE, async () => COMMIT)
}

// The warnings shown that are not a confirmation, as [text, ...buttons].
function notifications(): unknown[][] {
  return vs.showWarningMessage.mock.calls.filter((c) => typeof c[1] !== "object")
}

describe("the status bar", () => {
  it("shows the workspace's name and state", async () => {
    const s = status()
    await s.poll()
    expect(vs.item.text).toContain("my-ws: running")
    expect(vs.item.command).toBe(MENU_COMMAND)
    expect(notifications()).toEqual([])
    s.dispose()
  })

  it("asks spin every 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] })
    const s = status()
    s.start()
    await vi.waitFor(() => expect(vs.item.text).toContain("running"))
    answer("WORKSPACE_STATE_STOPPING")
    vi.advanceTimersByTime(POLL_MS)
    await vi.waitFor(() => expect(vs.item.text).toContain("stopping"))
    expect(invocations().filter((a) => a[0] === "workspace")).toHaveLength(2)
    s.dispose()
  })

  it("offers to resume once when the workspace is suspended, and again once it went down again", async () => {
    const s = status()
    await s.poll()
    answer("WORKSPACE_STATE_STOPPED", "snap-1")
    await s.poll()
    expect(vs.item.text).toContain("my-ws: suspended")
    expect(notifications()).toEqual([["Workspace my-ws is suspended", RESUME]])
    await s.poll()
    expect(notifications()).toHaveLength(1)
    answer("WORKSPACE_STATE_RUNNING")
    await s.poll()
    answer("WORKSPACE_STATE_STOPPED")
    await s.poll()
    expect(notifications()).toEqual([
      ["Workspace my-ws is suspended", RESUME],
      ["Workspace my-ws is stopped", RESUME],
    ])
    s.dispose()
  })

  it("shows a failure to read the state once while it lasts", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "unreachable")
    const s = status()
    await s.poll()
    await s.poll()
    expect(vs.item.text).toContain("$(warning)")
    expect(vs.showErrorMessage).toHaveBeenCalledTimes(1)
    expect(vs.showErrorMessage.mock.calls[0]?.[1]).toBe(BUTTON.retry)
    s.dispose()
  })
})

describe("Resume and Reconnect", () => {
  it("starts the workspace with spin code --start and reloads the window", async () => {
    vs.showWarningMessage.mockResolvedValueOnce(RESUME)
    const s = status()
    answer("WORKSPACE_STATE_STOPPED", "snap-1")
    await s.poll()
    await vi.waitFor(() =>
      expect(vs.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow"),
    )
    const code = invocations().find((a) => a[0] === "code")
    expect(code).toEqual(
      expect.arrayContaining(["code", "my-ws", "--no-open", "--vscode-commit", COMMIT, "--start"]),
    )
    s.dispose()
  })

  it("shows a failed start with its action, and does not reload", async () => {
    vi.stubEnv("FAKE_SPIN_SCENARIO", join(dir, "fail.json"))
    writeFileSync(join(dir, "fail.json"), JSON.stringify({ code: { error: "no_capacity" } }))
    await status().resume()
    expect(vs.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
    expect(vs.showErrorMessage).toHaveBeenCalledWith(expect.any(String), BUTTON.retry)
  })

  it("updates the CLI once for a start refused as outdated, and says so when the update did not take", async () => {
    vi.stubEnv("FAKE_SPIN_SCENARIO", join(dir, "fail.json"))
    writeFileSync(join(dir, "fail.json"), JSON.stringify({ code: { error: "cli_outdated" } }))
    configureErrors({
      cli: cli(),
      output: { appendLine: () => {}, show: () => {} },
      binary: () => Promise.resolve(FAKE_SPIN),
      extensionVersion: "0.0.0",
    })
    await status().resume()
    expect(invocations().map((a) => a[0])).toEqual(["code", "update", "code"])
    expect(vs.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("The update did not take."),
      BUTTON.details,
    )
    expect(vs.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
  })

  it("Cancel stops spin code, shows nothing and does not reload", async () => {
    vi.stubEnv("FAKE_SPIN_SCENARIO", join(dir, "slow.json"))
    writeFileSync(
      join(dir, "slow.json"),
      JSON.stringify({ code: { stdout: [{ folder_uri: "x" }], delayMs: 10_000 } }),
    )
    vs.withProgress.mockImplementation(progress(true))
    const started = Date.now()
    await status().resume()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(vs.showErrorMessage).not.toHaveBeenCalled()
    expect(vs.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
  })

  it("does nothing when the notification is dismissed", async () => {
    vs.showWarningMessage.mockResolvedValueOnce(undefined)
    await status().offerResume("my-ws", "suspended")
    expect(invocations()).toEqual([])
    expect(vs.executeCommand).not.toHaveBeenCalled()
  })
})

describe("the menu", () => {
  function choose(label: string): void {
    vs.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
      items.find((i) => i.label === label),
    )
  }

  it("opens the workspace's dashboard page", async () => {
    const s = status()
    await s.poll()
    choose(MENU.dashboard)
    await s.menu()
    expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(
      "https://app.spinbox.test/workspaces/ws-1",
    )
  })

  it("stops the workspace once confirmed", async () => {
    const s = status()
    await s.poll()
    choose(MENU.stop)
    vs.showWarningMessage.mockResolvedValueOnce(MENU.stop)
    await s.menu()
    expect(invocations()).toContainEqual(["workspace", "stop", "ws-1", "-o", "json"])
  })

  it("Cancel stops spin workspace stop and shows nothing", async () => {
    const s = status()
    await s.poll()
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({ "workspace stop": { stdout: [{}], delayMs: 10_000 } }),
    )
    choose(MENU.stop)
    vs.showWarningMessage.mockResolvedValueOnce(MENU.stop)
    vs.withProgress.mockImplementation(progress(true))
    const started = Date.now()
    await s.menu()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(vs.showErrorMessage).not.toHaveBeenCalled()
  })

  it("does not stop it unconfirmed", async () => {
    const s = status()
    choose(MENU.stop)
    await s.menu()
    expect(invocations().filter((a) => a[1] === "stop")).toEqual([])
  })

  it("offers resume in place of stop while the workspace is down", async () => {
    const s = status()
    answer("WORKSPACE_STATE_STOPPED")
    await s.poll()
    vs.showQuickPick.mockResolvedValueOnce(undefined)
    await s.menu()
    const items = (vs.showQuickPick.mock.calls[0]?.[0] ?? []) as { label: string }[]
    const labels = items.map((i) => i.label)
    expect(labels).toEqual([MENU.dashboard, MENU.resume, MENU.copyHost])
  })

  it("copies the SSH host", async () => {
    choose(MENU.copyHost)
    await status().menu()
    expect(vs.writeText).toHaveBeenCalledWith("spin.my-ws")
  })
})

describe("registerStatus", () => {
  const context = () => ({ subscriptions: [] as unknown[] }) as never

  it("shows the item in a window connected to spin.<workspace>", () => {
    vs.env.remoteName = "ssh-remote"
    vs.workspace.workspaceFolders = [{ uri: { authority: "ssh-remote+spin.my-ws", path: "/root" } }]
    const ctx = context()
    registerStatus(ctx, cli())
    expect(vs.createStatusBarItem).toHaveBeenCalledTimes(1)
    expect(vs.executeCommand).toHaveBeenCalledWith("setContext", "spinbox.inWorkspace", true)
    for (const d of (ctx as { subscriptions: { dispose: () => void }[] }).subscriptions) {
      d.dispose()
    }
  })

  it("shows nothing in any other window", () => {
    vs.env.remoteName = "ssh-remote"
    vs.workspace.workspaceFolders = [{ uri: { authority: "ssh-remote+devbox", path: "/root" } }]
    registerStatus(context(), cli())
    expect(vs.createStatusBarItem).not.toHaveBeenCalled()
    expect(vs.registerCommand).toHaveBeenCalledWith(MENU_COMMAND, expect.any(Function))
  })
})

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProcessSpinCli } from "../../src/cli/client"
import type { Workspace } from "../../src/cli/contract"
import { BUTTON, configureErrors, TEXT } from "../../src/errors"
import { POLL_MS, registerViews, WELCOME_SIGN_IN } from "../../src/views"
import type { WorkspacesTree } from "../../src/views/workspaces"
import { FAKE_SPIN } from "./fake-spin"

interface FakeView {
  visible: boolean
  message: string | undefined
  visibility: (() => void) | undefined
}

const vs = vi.hoisted(() => ({
  view: undefined as unknown as FakeView,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executeCommand: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}))

vi.mock("vscode", () => {
  class EventEmitter {
    private fns: (() => void)[] = []
    event = (fn: () => void) => {
      this.fns.push(fn)
      return { dispose: () => {} }
    }
    fire() {
      for (const fn of this.fns) fn()
    }
  }
  class TreeItem {
    id?: string
    iconPath?: unknown
    description?: string
    tooltip?: string
    contextValue?: string
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  }
  class ThemeIcon {
    constructor(
      public id: string,
      public color?: { id: string },
    ) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0 },
    window: {
      createTreeView: () => {
        vs.view.visibility = undefined
        return Object.assign(vs.view, {
          onDidChangeVisibility: (fn: () => void) => {
            vs.view.visibility = fn
            return { dispose: () => {} }
          },
          dispose: () => {},
        })
      },
      withProgress: (_o: unknown, task: () => Promise<unknown>) => task(),
      showErrorMessage: vs.showErrorMessage,
      showWarningMessage: vs.showWarningMessage,
    },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        vs.commands.set(id, fn)
        return { dispose: () => {} }
      },
      executeCommand: vs.executeCommand,
    },
  }
})

function workspace(id: string, fields: Partial<Workspace>): Partial<Workspace> {
  return {
    id,
    name: `ws-${id}`,
    state: "WORKSPACE_STATE_RUNNING",
    url: "",
    failureReason: "",
    failureSummary: "",
    waitingReason: "",
    suspendedSnapshotId: "",
    allowedActions: [],
    ...fields,
  }
}

// One workspace per state the view tells apart.
const ONE_OF_EACH = [
  workspace("run", { allowedActions: ["WORKSPACE_ACTION_STOP"] }),
  workspace("stop", {
    state: "WORKSPACE_STATE_STOPPED",
    allowedActions: ["WORKSPACE_ACTION_START", "WORKSPACE_ACTION_DELETE"],
  }),
  workspace("susp", {
    state: "WORKSPACE_STATE_STOPPED",
    suspendedSnapshotId: "snap-1",
    allowedActions: ["WORKSPACE_ACTION_START", "WORKSPACE_ACTION_START_FROM_DISK"],
  }),
  workspace("boot", { state: "WORKSPACE_STATE_STARTING" }),
  workspace("fail", {
    state: "WORKSPACE_STATE_FAILED",
    failureSummary: "the disk did not attach",
    allowedActions: ["WORKSPACE_ACTION_START"],
  }),
]

let dir: string

function scenario(answers: object): void {
  const file = join(dir, "scenario.json")
  writeFileSync(file, JSON.stringify(answers))
  vi.stubEnv("FAKE_SPIN_SCENARIO", file)
}

function invocations(): string[][] {
  return readFileSync(join(dir, "log"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[])
}

const lists = () => invocations().filter((a) => a[0] === "workspace" && a[1] === "list").length

// Registers the view as activation does, visible or not, and when visible waits for the listing
// that showing it runs.
async function register(visible = true): Promise<WorkspacesTree> {
  vs.view = { visible, message: undefined, visibility: undefined }
  const context = { subscriptions: [] as unknown[] }
  const cli = new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} })
  const tree = registerViews(context as never, cli)
  if (visible) {
    await new Promise<void>((r) => tree.onDidChangeTreeData(() => r()))
  }
  return tree
}

function rows(tree: WorkspacesTree) {
  return tree.getChildren().map((id) => tree.getTreeItem(id))
}

function command(id: string): (...args: unknown[]) => Promise<unknown> {
  const fn = vs.commands.get(id)
  if (fn === undefined) {
    throw new Error(`${id} is not registered`)
  }
  return async (...args) => fn(...args)
}

beforeEach(() => {
  vi.resetAllMocks()
  vs.commands.clear()
  configureErrors(undefined)
  dir = mkdtempSync(join(tmpdir(), "views-"))
  writeFileSync(join(dir, "log"), "")
  vi.stubEnv("FAKE_SPIN_LOG", join(dir, "log"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("spinbox.workspaces", () => {
  it("shows each workspace by name, with an icon and a description of its own state", async () => {
    scenario({ "workspace list": { stdout: [{ items: ONE_OF_EACH }] } })
    const tree = await register()
    const shown = rows(tree).map((r) => ({
      label: r.label,
      icon: (r.iconPath as { id: string }).id,
      description: r.description,
      contextValue: r.contextValue,
    }))
    expect(shown).toEqual([
      {
        label: "ws-run",
        icon: "vm-running",
        description: "running",
        contextValue: "workspace stoppable",
      },
      {
        label: "ws-stop",
        icon: "vm-outline",
        description: "stopped",
        contextValue: "workspace startable",
      },
      {
        label: "ws-susp",
        icon: "debug-pause",
        description: "suspended",
        contextValue: "workspace startable",
      },
      {
        label: "ws-boot",
        icon: "loading~spin",
        description: "starting",
        contextValue: "workspace",
      },
      {
        label: "ws-fail",
        icon: "error",
        description: "failed - the disk did not attach",
        contextValue: "workspace startable",
      },
    ])
    // Its elements are the ids, which a row's menu hands spinbox.openWorkspace as they are.
    expect(tree.getChildren()).toEqual(["run", "stop", "susp", "boot", "fail"])
    expect(vs.executeCommand).toHaveBeenCalledWith("setContext", "spinbox.workspaces", "listed")
  })

  it("lists when shown, every 30 s while visible, and not while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    await register(false)
    expect(lists()).toBe(0)

    vs.view.visible = true
    vs.view.visibility?.()
    await vi.waitFor(() => expect(lists()).toBe(1))
    vi.advanceTimersByTime(POLL_MS)
    await vi.waitFor(() => expect(lists()).toBe(2))

    vs.view.visible = false
    vs.view.visibility?.()
    vi.advanceTimersByTime(3 * POLL_MS)
    await new Promise((r) => setTimeout(r, 200))
    expect(lists()).toBe(2)
  })

  it("Start and Stop run spin workspace start|stop with the row's id, then list again", async () => {
    await register()
    await command("spinbox.startWorkspace")("stop")
    await command("spinbox.stopWorkspace")("run")
    expect(lists()).toBe(3)
    const acts = invocations().filter((a) => a[1] === "start" || a[1] === "stop")
    expect(acts).toEqual([
      ["workspace", "start", "stop", "-o", "json"],
      ["workspace", "stop", "run", "-o", "json"],
    ])
  })

  it("Refresh lists again", async () => {
    await register()
    await command("spinbox.refresh")()
    expect(lists()).toBe(2)
  })

  it("refreshes asked while a listing runs are one more listing after it", async () => {
    await register()
    const refresh = command("spinbox.refresh")
    await Promise.all([refresh(), refresh(), refresh()])
    expect(lists()).toBe(3)
  })

  it("a failed Start is shown with its action, whose Retry starts it again", async () => {
    await register()
    scenario({ "workspace start": { error: "no_capacity" } })
    vs.showErrorMessage.mockResolvedValueOnce(BUTTON.retry).mockResolvedValue(undefined)
    await command("spinbox.startWorkspace")("stop")
    expect(vs.showErrorMessage).toHaveBeenCalledWith(TEXT.no_capacity, BUTTON.retry)
    expect(invocations().filter((a) => a[1] === "start")).toHaveLength(2)
  })

  it("signed out, shows the welcome and no notification; its Sign In lists once signed in", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "not_signed_in")
    const tree = await register()
    expect(tree.getChildren()).toEqual([])
    expect(vs.executeCommand).toHaveBeenCalledWith("setContext", "spinbox.workspaces", "signedOut")
    expect(vs.showWarningMessage).not.toHaveBeenCalled()
    expect(vs.showErrorMessage).not.toHaveBeenCalled()

    vi.unstubAllEnvs()
    vi.stubEnv("FAKE_SPIN_LOG", join(dir, "log"))
    vs.executeCommand.mockImplementation(async (id: string) => id === "spinbox.signIn")
    await command(WELCOME_SIGN_IN)()
    expect(vs.executeCommand).toHaveBeenCalledWith("spinbox.signIn")
    expect(tree.getChildren()).toEqual(["ws-1"])
  })

  it("a failed listing is shown once, stays on the view until one succeeds", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "unreachable")
    const tree = await register()
    await tree.refresh()
    expect(vs.showErrorMessage).toHaveBeenCalledTimes(1)
    expect(vs.showErrorMessage).toHaveBeenCalledWith(TEXT.unreachable, BUTTON.retry)
    expect(vs.view.message).toBe(TEXT.unreachable)

    vi.stubEnv("FAKE_SPIN_ERROR", "")
    await tree.refresh()
    expect(vs.view.message).toBe("")
    expect(tree.getChildren()).toEqual(["ws-1"])
  })
})

describe("package.json", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  const items: { command: string; when: string; group: string }[] =
    manifest.contributes.menus["view/item/context"]

  // A when clause's viewItem regex, run against what a row's contextValue is.
  const offered = (command: string, contextValue: string, group: string) =>
    items.some((m) => {
      const re = /viewItem =~ \/(.+)\/$/.exec(m.when)?.[1]
      return (
        m.command === command &&
        m.group.startsWith(group) &&
        m.when.includes("view == spinbox.workspaces") &&
        re !== undefined &&
        new RegExp(re).test(contextValue)
      )
    })

  it("offers Open on every row, Start and Stop where the row allows them, inline and in its menu", () => {
    for (const group of ["inline", "navigation"]) {
      expect(offered("spinbox.openWorkspace", "workspace", group)).toBe(true)
      expect(offered("spinbox.startWorkspace", "workspace startable", group)).toBe(true)
      expect(offered("spinbox.startWorkspace", "workspace stoppable", group)).toBe(false)
      expect(offered("spinbox.stopWorkspace", "workspace stoppable", group)).toBe(true)
      expect(offered("spinbox.stopWorkspace", "workspace startable", group)).toBe(false)
    }
    expect(manifest.contributes.menus["view/title"]).toContainEqual(
      expect.objectContaining({ command: "spinbox.refresh", when: "view == spinbox.workspaces" }),
    )
  })

  it("welcomes a signed-out view with Sign In", () => {
    expect(manifest.contributes.viewsWelcome).toContainEqual({
      view: "spinbox.workspaces",
      contents: `Sign in to Spinbox to see your workspaces.\n[Sign In](command:${WELCOME_SIGN_IN})`,
      when: "spinbox.workspaces == signedOut",
    })
  })
})

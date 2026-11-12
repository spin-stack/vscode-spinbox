import { beforeEach, describe, expect, it, vi } from "vitest"

// The vscode API the modules reach: the installed extensions, each with its activation events and
// what its activation does, as a map the test controls.
const vscode = vi.hoisted(() => {
  const installed = new Map<
    string,
    { packageJSON: { activationEvents: string[] }; activate: () => Promise<unknown> }
  >()
  return {
    installed,
    env: { appName: "Visual Studio Code" },
    extensions: {
      getExtension: (id: string) => installed.get(id),
      onDidChange: () => ({ dispose: () => {} }),
    },
    window: {
      showInformationMessage:
        vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
      showWarningMessage:
        vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
      showErrorMessage:
        vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(),
    },
    commands: {
      executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(),
    },
  }
})
vi.mock("vscode", () => vscode)

import type { Memento } from "vscode"
import { MICROSOFT_REMOTE_SSH } from "../../src/remote/extension"
import { ENABLE_PROPOSED_API, openThrough, route, TOLD_KEY } from "../../src/remote/resolver"
import { SPIN_RESOLVER } from "../../src/status/authority"

// The resolver, installed: one that answers spin+ unless events say otherwise, and whose
// activation rejects as it does when VS Code withholds the proposed API.
function installResolver(
  opts: { events?: string[]; refused?: boolean } = {},
): ReturnType<typeof vi.fn> {
  const activate = vi.fn(async () => {
    if (opts.refused === true) {
      throw new Error("Extension 'spin-stack.open-remote-ssh' CANNOT use API proposal: resolvers.")
    }
  })
  vscode.installed.set(SPIN_RESOLVER, {
    packageJSON: {
      activationEvents: opts.events ?? [
        "onResolveRemoteAuthority:ssh-remote",
        "onResolveRemoteAuthority:spin",
      ],
    },
    activate,
  })
  return activate
}

function memento(): Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as Memento & { values: Map<string, unknown> }
}

beforeEach(() => {
  vscode.installed.clear()
  vscode.window.showInformationMessage.mockReset()
  vscode.window.showWarningMessage.mockReset()
  vscode.window.showErrorMessage.mockReset()
  vscode.commands.executeCommand.mockReset()
})

describe("route", () => {
  it("goes through the resolver once it activates", async () => {
    const activate = installResolver()
    expect(await route()).toEqual({ spin: true })
    expect(activate).toHaveBeenCalledOnce()
  })

  it("falls back when the resolver is not installed", async () => {
    expect(await route()).toEqual({ spin: false, because: "missing" })
  })

  // A build of open-remote-ssh from before the resolver activates fine and answers no spin+.
  it("falls back, without activating it, when the build installed answers no spin+", async () => {
    const activate = installResolver({ events: ["onResolveRemoteAuthority:ssh-remote"] })
    expect(await route()).toEqual({ spin: false, because: "missing" })
    expect(activate).not.toHaveBeenCalled()
  })

  it("falls back when VS Code does not let the resolver activate", async () => {
    installResolver({ refused: true })
    expect(await route()).toEqual({ spin: false, because: "disabled" })
  })
})

describe("openThrough", () => {
  it("opens through the resolver without asking for Remote-SSH or telling anything", async () => {
    installResolver()
    const state = memento()
    expect(await openThrough(state)).toBe(true)
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
    expect(state.values.size).toBe(0)
  })

  it("opens over Remote-SSH and says, with the exact argv.json line, what the resolver needs", async () => {
    installResolver({ refused: true })
    vscode.installed.set(MICROSOFT_REMOTE_SSH, {
      packageJSON: { activationEvents: [] },
      activate: async () => {},
    })
    vscode.window.showInformationMessage.mockResolvedValue(undefined)
    expect(await openThrough(memento())).toBe(false)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce()
    const [message] = vscode.window.showInformationMessage.mock.calls[0] ?? []
    expect(ENABLE_PROPOSED_API).toBe('"enable-proposed-api": ["spin-stack.open-remote-ssh"]')
    expect(message).toContain(ENABLE_PROPOSED_API)
    expect(message).toContain("does not let")
  })

  it("tells each reason once", async () => {
    vscode.installed.set(MICROSOFT_REMOTE_SSH, {
      packageJSON: { activationEvents: [] },
      activate: async () => {},
    })
    vscode.window.showInformationMessage.mockResolvedValue(undefined)
    const state = memento()
    await openThrough(state)
    await openThrough(state)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce()
    expect(vscode.window.showInformationMessage.mock.calls[0]?.[0]).toContain(
      `install ${SPIN_RESOLVER}`,
    )
    expect(state.values.get(TOLD_KEY)).toBe("missing")

    // Installed since, and held back by VS Code: a new reason, told once too.
    installResolver({ refused: true })
    await openThrough(state)
    await openThrough(state)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2)
    expect(state.values.get(TOLD_KEY)).toBe("disabled")
  })

  it("opens argv.json when the person asks", async () => {
    vscode.installed.set(MICROSOFT_REMOTE_SSH, {
      packageJSON: { activationEvents: [] },
      activate: async () => {},
    })
    vscode.window.showInformationMessage.mockImplementation(async (_m, ...items) => items[0])
    await openThrough(memento())
    await vi.waitFor(() =>
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.configureRuntimeArguments",
      ),
    )
  })

  it("opens nothing, and tells nothing, when there is no resolver and no Remote-SSH is installed", async () => {
    vscode.window.showWarningMessage.mockResolvedValue(undefined)
    const state = memento()
    expect(await openThrough(state)).toBeUndefined()
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
    expect(state.values.size).toBe(0)
  })
})

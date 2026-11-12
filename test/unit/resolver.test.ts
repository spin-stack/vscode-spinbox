import { beforeEach, describe, expect, it, vi } from "vitest"

// The vscode API the modules reach: the installed extensions, each with what its activation does,
// as a map the test controls.
const vscode = vi.hoisted(() => {
  const installed = new Map<string, { activate: () => Promise<unknown> }>()
  return {
    installed,
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
import {
  ENABLE_PROPOSED_API,
  INSTALL,
  openThrough,
  route,
  TOLD_KEY,
} from "../../src/remote/resolver"
import { SPIN_RESOLVER } from "../../src/status/authority"

// The resolver, installed, whose activation rejects when refused, as it does when VS Code
// withholds the proposed API.
function installResolver(opts: { refused?: boolean } = {}): ReturnType<typeof vi.fn> {
  const activate = vi.fn(async () => {
    if (opts.refused === true) {
      throw new Error("Extension 'spin-stack.spinbox-remote' CANNOT use API proposal: resolvers.")
    }
  })
  vscode.installed.set(SPIN_RESOLVER, { activate })
  return activate
}

function installRemoteSSH(): void {
  vscode.installed.set(MICROSOFT_REMOTE_SSH, { activate: async () => {} })
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
    installRemoteSSH()
    vscode.window.showInformationMessage.mockResolvedValue(undefined)
    expect(await openThrough(memento())).toBe(false)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce()
    const [message] = vscode.window.showInformationMessage.mock.calls[0] ?? []
    expect(ENABLE_PROPOSED_API).toBe('"enable-proposed-api": ["spin-stack.spinbox-remote"]')
    expect(message).toContain(ENABLE_PROPOSED_API)
    expect(message).toContain("does not let")
  })

  it("says how to install the resolver when it is missing", async () => {
    installRemoteSSH()
    vscode.window.showInformationMessage.mockResolvedValue(undefined)
    await openThrough(memento())
    const [message] = vscode.window.showInformationMessage.mock.calls[0] ?? []
    expect(INSTALL).toBe("spin vscode install")
    expect(message).toContain(`${SPIN_RESOLVER}) by running \`spin vscode install\``)
    expect(message).toContain(ENABLE_PROPOSED_API)
  })

  it("tells each reason once", async () => {
    installRemoteSSH()
    vscode.window.showInformationMessage.mockResolvedValue(undefined)
    const state = memento()
    await openThrough(state)
    await openThrough(state)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce()
    expect(state.values.get(TOLD_KEY)).toBe("missing")

    // Installed since, and held back by VS Code: a new reason, told once too.
    installResolver({ refused: true })
    await openThrough(state)
    await openThrough(state)
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2)
    expect(state.values.get(TOLD_KEY)).toBe("disabled")
  })

  it("opens argv.json when the person asks", async () => {
    installRemoteSSH()
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

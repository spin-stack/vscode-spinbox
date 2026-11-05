import { beforeEach, describe, expect, it, vi } from "vitest"

// The vscode API the module reaches, with the installed extensions as a set the test controls.
const vscode = vi.hoisted(() => {
  const installed = new Set<string>()
  const changeListeners = new Set<() => void>()
  return {
    installed,
    changeListeners,
    env: { appName: "Visual Studio Code" },
    extensions: {
      getExtension: (id: string) => (installed.has(id) ? { id } : undefined),
      onDidChange: (fn: () => void) => {
        changeListeners.add(fn)
        return { dispose: () => changeListeners.delete(fn) }
      },
    },
    window: {
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

import {
  ensureRemoteExtension,
  INSTALL_WAIT_MS,
  MICROSOFT_REMOTE_SSH,
  OPEN_REMOTE_SSH,
} from "../../src/remote/extension"

// installLater has the install command return before the extension host loads the extension,
// as it does in VS Code, and announces it through onDidChange.
function installLater(): void {
  vscode.commands.executeCommand.mockImplementation(async (_command, id) => {
    setTimeout(() => {
      vscode.installed.add(id as string)
      for (const fn of vscode.changeListeners) fn()
    }, 10)
  })
}

beforeEach(() => {
  vscode.installed.clear()
  vscode.changeListeners.clear()
  vscode.env.appName = "Visual Studio Code"
  vscode.window.showWarningMessage.mockReset()
  vscode.window.showErrorMessage.mockReset()
  vscode.commands.executeCommand.mockReset()
  vi.useRealTimers()
})

describe("ensureRemoteExtension", () => {
  it.each([MICROSOFT_REMOTE_SSH, OPEN_REMOTE_SSH])(
    "goes on without asking when %s is installed",
    async (id) => {
      vscode.installed.add(id)
      vscode.env.appName = id === OPEN_REMOTE_SSH ? "VSCodium" : "Visual Studio Code"
      expect(await ensureRemoteExtension()).toBe(true)
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["Visual Studio Code", MICROSOFT_REMOTE_SSH],
    ["Visual Studio Code - Insiders", MICROSOFT_REMOTE_SSH],
    ["VSCodium", OPEN_REMOTE_SSH],
    ["Cursor", OPEN_REMOTE_SSH],
  ])("with none installed, %s offers %s and waits until it loads", async (appName, id) => {
    vscode.env.appName = appName
    vscode.window.showWarningMessage.mockImplementation(async (_m, ...items) => items[0])
    installLater()
    expect(await ensureRemoteExtension()).toBe(true)
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining(id),
      `Install ${id}`,
    )
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.extensions.installExtension",
      id,
    )
    expect(vscode.installed.has(id)).toBe(true)
  })

  it("with none installed and the offer dismissed, does not open", async () => {
    vscode.window.showWarningMessage.mockResolvedValue(undefined)
    expect(await ensureRemoteExtension()).toBe(false)
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })

  it("shows a failed install with Retry, and installs on it", async () => {
    vscode.window.showWarningMessage.mockImplementation(async (_m, ...items) => items[0])
    vscode.window.showErrorMessage.mockImplementation(async (_m, ...items) => items[0])
    vscode.commands.executeCommand.mockRejectedValueOnce(new Error("offline"))
    vscode.commands.executeCommand.mockImplementationOnce(async (_command, id) => {
      vscode.installed.add(id as string)
    })
    expect(await ensureRemoteExtension()).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("offline"),
      "Retry",
    )
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2)
  })

  it("offers a reload when the install returns but the extension never loads", async () => {
    vi.useFakeTimers()
    vscode.window.showWarningMessage.mockImplementation(async (_m, ...items) => items[0])
    vscode.window.showErrorMessage.mockImplementation(async (_m, ...items) => items[0])
    vscode.commands.executeCommand.mockResolvedValue(undefined)
    const result = ensureRemoteExtension()
    await vi.advanceTimersByTimeAsync(INSTALL_WAIT_MS)
    expect(await result).toBe(false)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Reload"),
      "Reload Window",
    )
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("workbench.action.reloadWindow")
  })
})

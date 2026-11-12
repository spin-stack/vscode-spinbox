import { beforeEach, describe, expect, it, vi } from "vitest"

// The vscode API the module reaches, with the installed extensions as a set the test controls.
const vscode = vi.hoisted(() => {
  const installed = new Set<string>()
  const changeListeners = new Set<() => void>()
  return {
    installed,
    changeListeners,
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
  vscode.window.showWarningMessage.mockReset()
  vscode.window.showErrorMessage.mockReset()
  vscode.commands.executeCommand.mockReset()
  vi.useRealTimers()
})

describe("ensureRemoteExtension", () => {
  it("goes on without asking when Remote-SSH is installed", async () => {
    vscode.installed.add(MICROSOFT_REMOTE_SSH)
    expect(await ensureRemoteExtension()).toBe(true)
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
  })

  // Another Remote-SSH extension answers nothing Spinbox relies on.
  it("offers Remote-SSH, and waits until it loads, when another extension is all there is", async () => {
    const id = MICROSOFT_REMOTE_SSH
    vscode.installed.add("jeanp413.open-remote-ssh")
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

import * as vscode from "vscode"

// Spinbox opens a workspace through a vscode-remote://ssh-remote+ URI, which only a Remote-SSH
// extension answers. Microsoft's is on the Visual Studio Marketplace alone; every other editor
// (VSCodium, Cursor, ...) installs from Open VSX, where open-remote-ssh is the one there is.
export const MICROSOFT_REMOTE_SSH = "ms-vscode-remote.remote-ssh"
export const OPEN_REMOTE_SSH = "jeanp413.open-remote-ssh"
export const REMOTE_EXTENSIONS = [MICROSOFT_REMOTE_SSH, OPEN_REMOTE_SSH] as const

// How long to wait for the extension host to load the extension after the install returns.
export const INSTALL_WAIT_MS = 60_000

export function installedRemoteExtension(): string | undefined {
  return REMOTE_EXTENSIONS.find((id) => vscode.extensions.getExtension(id) !== undefined)
}

// The Visual Studio Marketplace serves only Microsoft's builds, whose appName starts with
// "Visual Studio Code" (Insiders included); the extension API does not name the gallery.
export function remoteExtensionForEditor(): string {
  return vscode.env.appName.startsWith("Visual Studio Code")
    ? MICROSOFT_REMOTE_SSH
    : OPEN_REMOTE_SSH
}

// ensureRemoteExtension answers whether a Remote-SSH extension is installed, offering to install
// the one this editor's marketplace carries when none is. false means the open cannot go on.
export async function ensureRemoteExtension(): Promise<boolean> {
  if (installedRemoteExtension() !== undefined) return true
  const id = remoteExtensionForEditor()
  const install = `Install ${id}`
  const choice = await vscode.window.showWarningMessage(
    `Spinbox opens workspaces over Remote-SSH, which needs the ${id} extension.`,
    install,
  )
  if (choice !== install) return false
  return installAndWait(id)
}

async function installAndWait(id: string): Promise<boolean> {
  const loaded = waitForExtension(id, INSTALL_WAIT_MS)
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", id)
  } catch (err) {
    loaded.cancel()
    const retry = "Retry"
    const message = err instanceof Error ? err.message : String(err)
    const choice = await vscode.window.showErrorMessage(
      `Spinbox could not install ${id}: ${message}`,
      retry,
    )
    return choice === retry ? installAndWait(id) : false
  }
  if (vscode.extensions.getExtension(id) !== undefined) {
    loaded.cancel()
    return true
  }
  if (await loaded.done) return true
  const reload = "Reload Window"
  const choice = await vscode.window.showErrorMessage(
    `${id} was installed but has not loaded yet. Reload the window, then open the workspace again.`,
    reload,
  )
  if (choice === reload) await vscode.commands.executeCommand("workbench.action.reloadWindow")
  return false
}

// waitForExtension resolves true once the extension host lists id, false after ms.
function waitForExtension(id: string, ms: number): { done: Promise<boolean>; cancel(): void } {
  let finish: (ok: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    const listener = vscode.extensions.onDidChange(() => {
      if (vscode.extensions.getExtension(id) !== undefined) finish(true)
    })
    const timer = setTimeout(() => finish(false), ms)
    finish = (ok) => {
      clearTimeout(timer)
      listener.dispose()
      resolve(ok)
    }
  })
  return {
    done,
    cancel: () => finish(false),
  }
}

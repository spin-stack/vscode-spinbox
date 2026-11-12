import * as vscode from "vscode"

// Without the resolver (resolver.ts), Spinbox opens a workspace through a
// vscode-remote://ssh-remote+ URI, which Microsoft's Remote-SSH answers.
export const MICROSOFT_REMOTE_SSH = "ms-vscode-remote.remote-ssh"

// How long to wait for the extension host to load the extension after the install returns.
export const INSTALL_WAIT_MS = 60_000

// ensureRemoteExtension answers whether Remote-SSH is installed, offering to install it when it is
// not. false means the open cannot go on.
export async function ensureRemoteExtension(): Promise<boolean> {
  const id = MICROSOFT_REMOTE_SSH
  if (vscode.extensions.getExtension(id) !== undefined) return true
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

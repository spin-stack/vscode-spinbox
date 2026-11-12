import * as vscode from "vscode"
import { SPIN_RESOLVER } from "../status/authority"
import { ensureRemoteExtension } from "./extension"

// Spinbox Remote resolves vscode-remote://spin+<workspace> through the spin CLI, and shows what
// refuses the connection, which Remote-SSH leaves in its log. It runs on VS Code's proposed
// resolvers API, which VS Code grants a third-party extension only when argv.json names it. So it
// is no extensionDependencies of this extension: a dependency that fails to activate keeps the
// extension that depends on it from activating, and Remote-SSH with it. The Marketplace refuses an
// extension that uses a proposed API, so `spin vscode install` installs it beside this one.

// The line argv.json needs for the resolver to run.
export const ENABLE_PROPOSED_API = `"enable-proposed-api": ["${SPIN_RESOLVER}"]`

// Where Spinbox keeps the last reason it told the person, so each is told once.
export const TOLD_KEY = "spinbox.resolverHint"

const OPEN_ARGV = "Open argv.json"

// What installs Spinbox Remote: the Marketplace, which VS Code reads, cannot carry it.
export const INSTALL = "spin vscode install"

// Why a workspace opens over Remote-SSH: the resolver is not installed, or it is and VS Code did
// not let it activate.
export type Fallback = "missing" | "disabled"

export type Route = { spin: true } | { spin: false; because: Fallback }

// route answers whether the resolver is there and active. Activating it is the check: without the
// proposed API, its registerRemoteAuthorityResolver throws, and the activation rejects.
export async function route(): Promise<Route> {
  const ext = vscode.extensions.getExtension(SPIN_RESOLVER)
  if (ext === undefined) {
    return { spin: false, because: "missing" }
  }
  try {
    await ext.activate()
  } catch {
    return { spin: false, because: "disabled" }
  }
  return { spin: true }
}

// openThrough answers how to open a workspace: through the resolver (true), over Remote-SSH
// (false), or not at all (undefined), when there is neither and the person installs no Remote-SSH
// extension. Falling back, it says once per reason how to have the resolver instead.
export async function openThrough(state: vscode.Memento): Promise<boolean | undefined> {
  const r = await route()
  if (r.spin) {
    return true
  }
  if (!(await ensureRemoteExtension())) {
    return undefined
  }
  tellOnce(state, r.because)
  return false
}

function tellOnce(state: vscode.Memento, because: Fallback): void {
  if (state.get<Fallback>(TOLD_KEY) === because) {
    return
  }
  void state.update(TOLD_KEY, because)
  const enable = `add ${ENABLE_PROPOSED_API} to argv.json and restart VS Code`
  const message =
    because === "disabled"
      ? `Spinbox opens workspaces over Remote-SSH: VS Code does not let ${SPIN_RESOLVER} use the proposed API it opens them with. To open them through Spinbox's own connection, which says why one does not open, ${enable}.`
      : `Spinbox opens workspaces over Remote-SSH. To open them through Spinbox's own connection, which says why one does not open, install Spinbox Remote (${SPIN_RESOLVER}) by running \`${INSTALL}\` in a terminal, ${enable}.`
  void Promise.resolve(vscode.window.showInformationMessage(message, OPEN_ARGV)).then((pick) =>
    pick === OPEN_ARGV
      ? vscode.commands.executeCommand("workbench.action.configureRuntimeArguments")
      : undefined,
  )
}

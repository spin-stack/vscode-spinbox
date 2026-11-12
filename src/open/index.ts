import * as vscode from "vscode"
import { showCliError } from "../errors"
import { openThrough } from "../remote/resolver"
import { trace } from "../telemetry/vscode"
import { readCommit } from "./editor"
import { type OpenCli, type OpenDeps, type OpenUi, openWorkspace, pickAndOpen } from "./open"
import { parseOpenUri } from "./target"

const ui: OpenUi = {
  progress: (title, task) =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (progress, token) => {
          const abort = new AbortController()
          token.onCancellationRequested(() => abort.abort())
          return task(abort.signal, (message) => progress.report({ message }))
        },
      ),
    ),
  pick: async (workspaces) => {
    const picked = await vscode.window.showQuickPick(
      workspaces.map((w) => ({
        label: w.name,
        description: w.state.replace("WORKSPACE_STATE_", "").toLowerCase(),
        workspace: w,
      })),
      { title: "Open a Spinbox workspace", placeHolder: "Workspace" },
    )
    return picked?.workspace
  },
  openFolder: async (folderUri) => {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(folderUri), {
      forceNewWindow: true,
    })
  },
  showCliError: (error, retry) => {
    void showCliError(error, retry)
  },
  showError: (message) => {
    void vscode.window.showErrorMessage(message)
  },
  showWarning: (message) => {
    void vscode.window.showWarningMessage(message)
  },
}

// deps answers what opening needs, or nothing when no extension is there to open what spin answers.
async function deps(context: vscode.ExtensionContext, cli: OpenCli): Promise<OpenDeps | undefined> {
  const spin = await openThrough(context.globalState)
  if (spin === undefined) {
    return undefined
  }
  return {
    cli,
    ui,
    commit: () => readCommit(vscode.env.appRoot),
    vscodeVersion: vscode.version,
    trace,
    spin,
  }
}

// registerOpen registers spinbox.openWorkspace and the handler of
// vscode://spin-stack.spinbox/open?workspace=<id>&path=<absolute path>. Neither runs spin until
// the resolver or a Remote-SSH extension is there to open what it answers.
export function registerOpen(context: vscode.ExtensionContext, cli: OpenCli): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("spinbox.openWorkspace", async (arg?: unknown) => {
      const d = await deps(context, cli)
      if (d !== undefined) {
        await pickAndOpen(d, typeof arg === "string" ? arg : undefined)
      }
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const parsed = parseOpenUri(uri)
        if ("reason" in parsed) {
          ui.showError(`Spinbox cannot open this link: ${parsed.reason}.`)
          return
        }
        const d = await deps(context, cli)
        if (d !== undefined) {
          await openWorkspace(d, parsed.target)
        }
      },
    }),
  )
}

import * as vscode from "vscode"
import { showCliError } from "../errors"
import { ensureRemoteExtension } from "../remote/extension"
import { trace } from "../telemetry/vscode"
import { readCommit } from "./editor"
import { type OpenCli, type OpenDeps, type OpenUi, openWorkspace, pickAndOpen } from "./open"
import { parseOpenUri } from "./target"

const ui: OpenUi = {
  progress: (title, task) =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => {
          const abort = new AbortController()
          token.onCancellationRequested(() => abort.abort())
          return task(abort.signal)
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
}

function deps(cli: OpenCli): OpenDeps {
  return {
    cli,
    ui,
    commit: () => readCommit(vscode.env.appRoot),
    vscodeVersion: vscode.version,
    trace,
  }
}

// registerOpen registers spinbox.openWorkspace and the handler of
// vscode://spin-stack.spinbox/open?workspace=<id>&path=<absolute path>. Neither runs spin until
// a Remote-SSH extension is there to open what it answers.
export function registerOpen(context: vscode.ExtensionContext, cli: OpenCli): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("spinbox.openWorkspace", async (arg?: unknown) => {
      if (await ensureRemoteExtension()) {
        await pickAndOpen(deps(cli), typeof arg === "string" ? arg : undefined)
      }
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const parsed = parseOpenUri(uri)
        if ("reason" in parsed) {
          ui.showError(`Spinbox cannot open this link: ${parsed.reason}.`)
          return
        }
        if (await ensureRemoteExtension()) {
          await openWorkspace(deps(cli), parsed.target)
        }
      },
    }),
  )
}

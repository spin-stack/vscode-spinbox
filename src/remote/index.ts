import { homedir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { CliError } from "../cli/client"
import { showCliError } from "../errors"
import { readCommit } from "../open/editor"
import { parseSpinRemote } from "../status/authority"
import { trace } from "../telemetry/vscode"
import { type ConnectCli, prepareConnection } from "./connect"
import { fileProxyStatus, type ProxyStatus, watchProxy } from "./proxy"

export const CLOSE_REMOTE = "workbench.action.remote.close"

// How often, and how long, the proxy's status is read while Remote-SSH connects.
const PROXY_INTERVAL_MS = 1_000
const PROXY_TIMEOUT_MS = 120_000

const closeRemote = async (): Promise<void> => {
  await vscode.commands.executeCommand(CLOSE_REMOTE)
}

// connectWindow readies the Spinbox workspace this window is resolving over Remote-SSH, if it is
// one (connect.ts), and then follows the connection Remote-SSH makes (proxy.ts). Activation waits
// on it, and Remote-SSH on activation, so it returns before following.
export async function connectWindow(cli: ConnectCli): Promise<void> {
  // The window's folder names the authority it resolves: env.remoteAuthority is the resolvers
  // proposal's, which this extension does not have.
  const authority = (vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.workspace.workspaceFile)
    ?.authority
  const since = Date.now()
  const ready = await prepareConnection(
    {
      cli,
      ui: {
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
        showCliError,
        closeRemote,
      },
      commit: () => readCommit(vscode.env.appRoot),
      vscodeVersion: vscode.version,
      trace,
    },
    vscode.env.remoteName,
    authority,
  )
  const remote = parseSpinRemote(vscode.env.remoteName, authority)
  if (ready === true && remote !== undefined) {
    void followProxy(join(homedir(), ".spin", "ssh", "hosts", remote.host), since)
  }
}

async function followProxy(dir: string, since: number): Promise<void> {
  let said: vscode.Disposable | undefined
  const status = await watchProxy(fileProxyStatus(dir, since), {
    intervalMs: PROXY_INTERVAL_MS,
    timeoutMs: PROXY_TIMEOUT_MS,
    report: (message) => {
      said?.dispose()
      said = vscode.window.setStatusBarMessage(`$(sync~spin) Spinbox: ${message}`)
    },
  })
  said?.dispose()
  if (status?.state === "failed") {
    await showProxyFailure(status)
    await closeRemote()
  }
}

// A failure the CLI has a code for is shown with its action; any other with what it said.
async function showProxyFailure(status: ProxyStatus): Promise<void> {
  if (status.error !== undefined) {
    await showCliError(new CliError({ error: status.error }))
    return
  }
  await vscode.window.showErrorMessage(`Spinbox could not connect: ${status.message}`)
}

import { homedir } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { CliError } from "../cli/client"
import { showCliError } from "../errors"
import { readCommit } from "../open/editor"
import { parseSpinRemote } from "../status/authority"
import { trace } from "../telemetry/vscode"
import { type ConnectCli, prepareConnection } from "./connect"
import { fileProxyStatus, type ProxyFailure, proxyFailure, watchProxy } from "./proxy"

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
    // From now: spin code's own ssh, and the shared connection it leaves, began before.
    void followProxy(remote.host, Date.now())
  }
}

async function followProxy(host: string, since: number): Promise<void> {
  let said: vscode.Disposable | undefined
  const dir = join(homedir(), ".spin", "ssh", "status")
  const status = await watchProxy(fileProxyStatus(dir, host, since), {
    intervalMs: PROXY_INTERVAL_MS,
    timeoutMs: PROXY_TIMEOUT_MS,
    report: (message) => {
      said?.dispose()
      said = vscode.window.setStatusBarMessage(`$(sync~spin) Spinbox: ${message}`)
    },
  })
  said?.dispose()
  const failure = status === undefined ? undefined : proxyFailure(status)
  if (failure !== undefined) {
    await showProxyFailure(failure)
    await closeRemote()
  }
}

const OPEN = "Open"

async function showProxyFailure(failure: ProxyFailure): Promise<void> {
  if ("envelope" in failure) {
    await showCliError(new CliError(failure.envelope))
    return
  }
  const pick = await vscode.window.showErrorMessage(
    failure.message,
    ...(failure.url === undefined ? [] : [OPEN]),
  )
  if (pick === OPEN && failure.url !== undefined) {
    await vscode.env.openExternal(vscode.Uri.parse(failure.url))
  }
}

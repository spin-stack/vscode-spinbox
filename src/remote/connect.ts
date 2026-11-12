import type { SpinCli } from "../cli/client"
import { parseSpinRemote } from "../status/authority"
import type { Trace } from "../telemetry"

// Remote-SSH connects a window to ssh-remote+spin.<workspace> by itself: on a reconnect, a reload
// or a recent folder, nothing of Spinbox's ran first, and a stopped workspace or a refused key is
// an opaque Remote-SSH error. So Spinbox activates on onResolveRemoteAuthority:ssh-remote, which
// VS Code waits for before Remote-SSH resolves, and readies the workspace first, as Coder's
// extension does (coder/vscode-coder docs/ARCHITECTURE.md): `spin code --start` starts it,
// attaches this VS Code's server, writes the ssh config, and connects once through it - which runs
// `spin ssh-prepare` and its launch-claim check - so a refusal is the CLI's error, with its action,
// here. A failure closes the remote, so Remote-SSH does not go on to fail its own way.

export type ConnectCli = Pick<SpinCli, "code">

export interface ConnectUi {
  // Runs task under a cancelable notification, as OpenUi's progress.
  progress<T>(
    title: string,
    task: (signal: AbortSignal, report: (message: string) => void) => Promise<T>,
  ): Promise<T>
  // The CLI's failure with its action, resolving once it is answered and the action has run.
  showCliError(error: unknown, retry: () => Promise<void>): Promise<void>
  // workbench.action.remote.close: the window leaves the remote it was connecting to.
  closeRemote(): Promise<void>
}

export interface ConnectDeps {
  cli: ConnectCli
  ui: ConnectUi
  commit(): Promise<string>
  vscodeVersion: string
  trace: Trace
}

// prepareConnection readies the workspace this window is resolving over Remote-SSH. It answers
// undefined for an authority that is no Spinbox workspace, having done nothing; true when Remote-SSH
// may connect; false when it closed the remote: the open failed and its retry did not take, or the
// person cancelled.
export async function prepareConnection(
  deps: ConnectDeps,
  remoteName: string | undefined,
  authority: string | undefined,
): Promise<boolean | undefined> {
  const remote = remoteName === "ssh-remote" ? parseSpinRemote(remoteName, authority) : undefined
  if (remote === undefined) {
    return undefined
  }
  let ready = false
  const attempt = async (): Promise<void> => {
    const commit = await deps.commit()
    const traceparent = deps.trace()
    ready = await deps.ui.progress(`Connecting to ${remote.workspace}`, async (signal, report) => {
      try {
        await deps.cli.code(remote.workspace, undefined, commit, {
          start: true,
          vscodeVersion: deps.vscodeVersion,
          signal,
          traceparent,
          onPreparing: (p) =>
            report(`Preparing VS Code ${p.vscode_version} for this installation (once): ${p.step}`),
        })
        return true
      } catch (err) {
        if (signal.aborted) {
          return false
        }
        throw err
      }
    })
  }
  try {
    await attempt()
  } catch (err) {
    await deps.ui.showCliError(err, attempt)
  }
  if (!ready) {
    await deps.ui.closeRemote()
  }
  return ready
}

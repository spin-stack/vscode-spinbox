import * as vscode from "vscode"
import type { SpinCli } from "../cli/client"
import type { Workspace } from "../cli/contract"
import { showCliError } from "../errors"
import { readCommit } from "../open/editor"
import { parseSpinRemote, type SpinRemote } from "./authority"

export type StatusCli = Pick<SpinCli, "listWorkspaces" | "code" | "run" | "version">

export const MENU_COMMAND = "spinbox.workspaceMenu"
// Set while the window is a Spinbox workspace: the menu's command is in the palette only then.
export const CONTEXT_KEY = "spinbox.inWorkspace"
export const POLL_MS = 30_000

export const RESUME = "Resume and Reconnect"
export const MENU = {
  dashboard: "Open in Dashboard",
  stop: "Stop",
  resume: RESUME,
  copyHost: "Copy SSH Host",
} as const

// registerStatus registers the workspace menu and, when this window is a Spinbox workspace over
// Remote-SSH, shows that workspace and its state in the status bar.
export function registerStatus(context: vscode.ExtensionContext, cli: StatusCli): void {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.workspace.workspaceFile
  const remote = parseSpinRemote(vscode.env.remoteName, folder?.authority)
  const status =
    remote === undefined
      ? undefined
      : new WorkspaceStatus(cli, remote, () => readCommit(vscode.env.appRoot))
  context.subscriptions.push(
    vscode.commands.registerCommand(MENU_COMMAND, async () => {
      if (status === undefined) {
        void vscode.window.showInformationMessage("This window is not a Spinbox workspace.")
        return
      }
      await status.menu()
    }),
  )
  if (status !== undefined) {
    context.subscriptions.push(status)
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, true)
    status.start()
  }
}

// The state a person reads: suspended for a stopped workspace that kept its memory, otherwise
// the state's own name.
export function stateLabel(ws: Workspace): string {
  if (ws.state === "WORKSPACE_STATE_STOPPED" && ws.suspendedSnapshotId !== "") {
    return "suspended"
  }
  return ws.state.replace("WORKSPACE_STATE_", "").toLowerCase()
}

function isDown(ws: Workspace): boolean {
  return ws.state === "WORKSPACE_STATE_STOPPED"
}

// WorkspaceStatus is the status bar item of the workspace this window is connected to. It asks
// spin for the workspace's state every POLL_MS, and offers to resume it each time it goes down.
export class WorkspaceStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private timer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private workspace: Workspace | undefined
  private down = false
  // The code of the failure last shown, so one that lasts is not shown again every poll.
  private failed: string | undefined

  constructor(
    private readonly cli: StatusCli,
    private readonly remote: SpinRemote,
    private readonly commit: () => Promise<string>,
  ) {
    this.item = vscode.window.createStatusBarItem(
      "spinbox.workspace",
      vscode.StatusBarAlignment.Left,
    )
    this.item.name = "Spinbox Workspace"
    this.item.command = MENU_COMMAND
    this.item.text = `$(sync~spin) ${remote.workspace}`
    this.item.tooltip = `Spinbox workspace ${remote.workspace}`
    this.item.show()
  }

  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  dispose(): void {
    clearInterval(this.timer)
    this.item.dispose()
  }

  // One poll at a time: a call while one runs waits for that one.
  poll(): Promise<void> {
    this.polling ??= this.refresh().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  private async refresh(): Promise<void> {
    let items: Workspace[]
    try {
      items = await this.cli.listWorkspaces()
    } catch (err) {
      this.item.text = `$(warning) ${this.remote.workspace}`
      this.item.tooltip = `Spinbox cannot read the state of ${this.remote.workspace}: ${(err as Error).message}`
      const code = (err as { code?: unknown }).code
      const key = typeof code === "string" ? code : "internal"
      if (this.failed !== key) {
        this.failed = key
        void showCliError(err, () => this.poll())
      }
      return
    }
    this.failed = undefined
    const name = this.remote.workspace
    const ws = items.find((w) => w.name === name) ?? items.find((w) => w.id === name)
    this.workspace = ws
    if (ws === undefined) {
      this.item.text = `$(warning) ${name}: not found`
      this.item.tooltip = `spin workspace list does not list ${name}: it was deleted, or it is not yours.`
      return
    }
    const label = stateLabel(ws)
    this.item.text = `$(${isDown(ws) ? "debug-pause" : "vm"}) ${ws.name}: ${label}`
    this.item.tooltip = `Spinbox workspace ${ws.name} is ${label}`
    const wasDown = this.down
    this.down = isDown(ws)
    if (this.down && !wasDown) {
      void this.offerResume(ws.name, label)
    }
  }

  // The notification of a workspace that went down; choosing its button resumes it.
  async offerResume(name: string, label: string): Promise<void> {
    if (
      (await vscode.window.showWarningMessage(`Workspace ${name} is ${label}`, RESUME)) === RESUME
    ) {
      await this.resume()
    }
  }

  // resume starts the workspace with `spin code --start`, which also writes its SSH config again,
  // and reloads the window, so Remote-SSH reconnects to the same folder. Cancelling the
  // notification stops spin and shows nothing.
  async resume(): Promise<void> {
    try {
      await this.resumeOnce()
    } catch (err) {
      await showCliError(err, () => this.resumeOnce())
    }
  }

  private async resumeOnce(): Promise<void> {
    const name = this.remote.workspace
    const commit = await this.commit()
    const done = await cancellable(`Resuming ${name}`, (signal) =>
      this.cli.code(name, undefined, commit, {
        start: true,
        vscodeVersion: vscode.version,
        signal,
      }),
    )
    if (done) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow")
    }
  }

  async menu(): Promise<void> {
    const items = [
      { label: MENU.dashboard, run: () => this.openDashboard() },
      this.down
        ? { label: MENU.resume, run: () => this.resume() }
        : { label: MENU.stop, run: () => this.stop() },
      { label: MENU.copyHost, description: this.remote.host, run: () => this.copyHost() },
    ]
    const picked = await vscode.window.showQuickPick(items, {
      title: this.item.tooltip?.toString() ?? this.remote.workspace,
    })
    await picked?.run()
  }

  // The dashboard's page of the workspace: the endpoint spin signs in to serves the dashboard.
  async openDashboard(): Promise<void> {
    try {
      const v = await this.cli.version()
      const id = this.workspace?.id ?? this.remote.workspace
      const url = `${v.endpoint.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(id)}`
      await vscode.env.openExternal(vscode.Uri.parse(url))
    } catch (err) {
      await showCliError(err, () => this.openDashboard())
    }
  }

  async stop(): Promise<void> {
    const name = this.remote.workspace
    const confirmed = await vscode.window.showWarningMessage(
      `Stop ${name}? This window loses its connection to it.`,
      { modal: true },
      MENU.stop,
    )
    if (confirmed !== MENU.stop) {
      return
    }
    await this.runStop()
  }

  private async runStop(): Promise<void> {
    try {
      await this.stopOnce()
    } catch (err) {
      await showCliError(err, () => this.stopOnce())
    }
  }

  private async stopOnce(): Promise<void> {
    const id = this.workspace?.id ?? this.remote.workspace
    const done = await cancellable(`Stopping ${this.remote.workspace}`, (signal) =>
      this.cli.run(["workspace", "stop", id], { signal }),
    )
    if (done) {
      await this.poll()
    }
  }

  async copyHost(): Promise<void> {
    await vscode.env.clipboard.writeText(this.remote.host)
    void vscode.window.showInformationMessage(`Copied ${this.remote.host}.`)
  }
}

// Runs task under a notification with Cancel, which aborts the signal task's spin runs with.
// Resolves false when it was cancelled, and rejects with any other failure.
async function cancellable(
  title: string,
  task: (signal: AbortSignal) => Promise<unknown>,
): Promise<boolean> {
  const abort = new AbortController()
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_progress, token) => {
        token.onCancellationRequested(() => abort.abort())
        return task(abort.signal)
      },
    )
  } catch (err) {
    if (abort.signal.aborted) {
      return false
    }
    throw err
  }
  return true
}

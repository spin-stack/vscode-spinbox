import type { SpinCli } from "../cli/client"
import type { Workspace } from "../cli/contract"
import type { Trace } from "../telemetry"
import { checkTarget, type OpenTarget } from "./target"

// What opening asks of the CLI.
export type OpenCli = Pick<SpinCli, "code" | "listWorkspaces">

// What opening asks of VS Code, so the sequence runs without it.
export interface OpenUi {
  // Runs task under a cancelable notification; cancelling it aborts the signal.
  progress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>
  // undefined when the person picks none.
  pick(workspaces: Workspace[]): Promise<Workspace | undefined>
  // vscode.openFolder in a new window.
  openFolder(folderUri: string): Promise<void>
  // A failure of the CLI, with its action and retry.
  showCliError(error: unknown, retry: () => Promise<void>): void
  // A failure of anything else: the link, or this VS Code.
  showError(message: string): void
}

export interface OpenDeps {
  cli: OpenCli
  ui: OpenUi
  // The commit of this VS Code; rejects when it names none.
  commit(): Promise<string>
  vscodeVersion: string
  // The traceparent of a new trace for one operation, which every spin command it runs joins;
  // undefined with telemetry off (src/telemetry).
  trace: Trace
}

// openWorkspace runs `spin code <workspace> [path] --no-open --start --vscode-commit ...` and
// opens the folder it answers in a new window. Every failure is shown, the CLI's with its action
// and a retry that runs it again; cancelling shows nothing. Each attempt is a trace of its own.
export async function openWorkspace(deps: OpenDeps, target: OpenTarget): Promise<void> {
  await open(deps, target, deps.trace())
}

// open is openWorkspace whose first attempt runs in the trace traceparent names.
async function open(
  deps: OpenDeps,
  target: OpenTarget,
  traceparent: string | undefined,
): Promise<void> {
  const reason = checkTarget(target.workspace, target.path)
  if (reason !== undefined) {
    deps.ui.showError(`Spinbox cannot open it: ${reason}.`)
    return
  }
  let commit: string
  try {
    commit = await deps.commit()
  } catch (err) {
    deps.ui.showError(`Spinbox cannot open ${target.workspace}: ${(err as Error).message}.`)
    return
  }
  // One attempt, which rejects with its failure; cancelling it resolves with nothing opened.
  const attempt = async (traceparent: string | undefined): Promise<void> => {
    const folderUri = await deps.ui.progress(`Opening ${target.workspace}`, async (signal) => {
      try {
        const r = await deps.cli.code(target.workspace, target.path, commit, {
          start: true,
          vscodeVersion: deps.vscodeVersion,
          signal,
          traceparent,
        })
        return r.folder_uri
      } catch (err) {
        if (signal.aborted) {
          return undefined
        }
        throw err
      }
    })
    if (folderUri !== undefined) {
      await deps.ui.openFolder(folderUri)
    }
  }
  try {
    await attempt(traceparent)
  } catch (err) {
    deps.ui.showCliError(err, () => attempt(deps.trace()))
  }
}

// pickAndOpen opens the workspace the command names, or the one the person picks from the list;
// the listing and the open it leads to are one trace.
export async function pickAndOpen(deps: OpenDeps, workspace?: string): Promise<void> {
  if (workspace !== undefined) {
    await openWorkspace(deps, { workspace })
    return
  }
  // One listing, and the open of what is picked from it, which shows its own failure; it
  // rejects with the listing's failure.
  const attempt = async (): Promise<void> => {
    const traceparent = deps.trace()
    const items = await deps.ui.progress("Listing workspaces", (signal) =>
      deps.cli.listWorkspaces({ signal, traceparent }).catch((err: unknown) => {
        if (signal.aborted) {
          return undefined
        }
        throw err
      }),
    )
    const picked = items === undefined ? undefined : await deps.ui.pick(items)
    if (picked !== undefined) {
      await open(deps, { workspace: picked.id }, traceparent)
    }
  }
  try {
    await attempt()
  } catch (err) {
    deps.ui.showCliError(err, attempt)
  }
}

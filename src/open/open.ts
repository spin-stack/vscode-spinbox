import type { SpinCli } from "../cli/client"
import type { Workspace } from "../cli/contract"
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
}

// openWorkspace runs `spin code <workspace> [path] --no-open --start --vscode-commit ...` and
// opens the folder it answers in a new window. Every failure is shown, the CLI's with its action
// and a retry that runs it again; cancelling shows nothing.
export async function openWorkspace(deps: OpenDeps, target: OpenTarget): Promise<void> {
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
  const run = async (): Promise<void> => {
    let folderUri: string | undefined
    try {
      folderUri = await deps.ui.progress(`Opening ${target.workspace}`, async (signal) => {
        try {
          const r = await deps.cli.code(target.workspace, target.path, commit, {
            start: true,
            vscodeVersion: deps.vscodeVersion,
            signal,
          })
          return r.folder_uri
        } catch (err) {
          if (signal.aborted) {
            return undefined
          }
          throw err
        }
      })
    } catch (err) {
      deps.ui.showCliError(err, run)
      return
    }
    if (folderUri !== undefined) {
      await deps.ui.openFolder(folderUri)
    }
  }
  await run()
}

// pickAndOpen opens the workspace the command names, or the one the person picks from the list.
export async function pickAndOpen(deps: OpenDeps, workspace?: string): Promise<void> {
  if (workspace !== undefined) {
    await openWorkspace(deps, { workspace })
    return
  }
  const run = async (): Promise<void> => {
    let picked: Workspace | undefined
    try {
      const items = await deps.ui.progress("Listing workspaces", (signal) =>
        deps.cli.listWorkspaces({ signal }).catch((err: unknown) => {
          if (signal.aborted) {
            return undefined
          }
          throw err
        }),
      )
      picked = items === undefined ? undefined : await deps.ui.pick(items)
    } catch (err) {
      deps.ui.showCliError(err, run)
      return
    }
    if (picked !== undefined) {
      await openWorkspace(deps, { workspace: picked.id })
    }
  }
  await run()
}

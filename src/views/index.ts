import * as vscode from "vscode"
import type { SpinCli } from "../cli/client"
import type { Workspace } from "../cli/contract"
import { showCliError } from "../errors"
import { VIEW, WorkspacesTree } from "./workspaces"

// How often the view lists the workspaces again while it is visible.
export const POLL_MS = 30_000

// The command the welcome's Sign In runs: spinbox.signIn, then the listing once it signed in.
export const WELCOME_SIGN_IN = "spinbox.workspaces.signIn"

export type ViewsCli = Pick<SpinCli, "listWorkspaces" | "run">

// registerViews registers the view spinbox.workspaces and the commands its rows and title offer:
// spinbox.refresh, spinbox.startWorkspace and spinbox.stopWorkspace. It lists the workspaces when
// the view is shown, every POLL_MS while it stays visible, and after each start or stop.
export function registerViews(context: vscode.ExtensionContext, cli: ViewsCli): WorkspacesTree {
  const tree = new WorkspacesTree(cli, (message) => {
    // An empty message is none.
    view.message = message ?? ""
  })
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: tree })

  let timer: NodeJS.Timeout | undefined
  const watch = () => {
    clearInterval(timer)
    timer = undefined
    if (view.visible) {
      void tree.refresh()
      timer = setInterval(() => void tree.refresh(), POLL_MS)
    }
  }

  // Runs `spin workspace <verb> <id>`, which answers the workspace as it now is, under the view's
  // progress bar. A failure is shown with its action; its retry runs the same command again.
  const act = (verb: "start" | "stop") => async (id: unknown) => {
    if (typeof id !== "string") {
      return
    }
    const once = async () => {
      try {
        await vscode.window.withProgress({ location: { viewId: VIEW } }, () =>
          cli.run<Workspace>(["workspace", verb, id]),
        )
      } finally {
        await tree.refresh()
      }
    }
    try {
      await once()
    } catch (err) {
      await showCliError(err, once)
    }
  }

  context.subscriptions.push(
    view,
    view.onDidChangeVisibility(watch),
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("spinbox.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("spinbox.startWorkspace", act("start")),
    vscode.commands.registerCommand("spinbox.stopWorkspace", act("stop")),
    vscode.commands.registerCommand(WELCOME_SIGN_IN, async () => {
      if ((await vscode.commands.executeCommand<boolean>("spinbox.signIn")) === true) {
        await tree.refresh()
      }
    }),
  )
  watch()
  return tree
}

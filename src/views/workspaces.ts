import * as vscode from "vscode"
import { CliError, type SpinCli } from "../cli/client"
import type { ErrorCode, Workspace } from "../cli/contract"
import { showCliError, TEXT } from "../errors"
import { contextValue, describe, ICON, shownState } from "./state"

export const VIEW = "spinbox.workspaces"
// What the view shows besides its rows, for package.json's viewsWelcome: "signedOut" once a
// listing answered not_signed_in, "listed" once one succeeded.
export const CONTEXT = "spinbox.workspaces"

export type WorkspacesCli = Pick<SpinCli, "listWorkspaces">

// The tree's elements are workspace ids, so a menu's command is called with the id itself: the
// argument spinbox.openWorkspace takes.
export class WorkspacesTree implements vscode.TreeDataProvider<string> {
  private readonly changed = new vscode.EventEmitter<undefined>()
  readonly onDidChangeTreeData = this.changed.event

  private items: Workspace[] = []
  private running: Promise<void> | undefined
  private next: Promise<void> | undefined
  // The code of the listing failure last shown, so a poll that fails the same way does not show it
  // again every 30 s. A success clears it.
  private shownFailure: ErrorCode | undefined

  constructor(
    private readonly cli: WorkspacesCli,
    // Set on the view: what the last listing failed with, above the rows it had before.
    private readonly setMessage: (message: string | undefined) => void,
  ) {}

  getChildren(element?: string): string[] {
    return element === undefined ? this.items.map((w) => w.id) : []
  }

  getTreeItem(id: string): vscode.TreeItem {
    const w = this.items.find((x) => x.id === id)
    const item = new vscode.TreeItem(w?.name ?? id, vscode.TreeItemCollapsibleState.None)
    item.id = id
    if (w === undefined) {
      return item
    }
    const icon = ICON[shownState(w)]
    item.iconPath = new vscode.ThemeIcon(
      icon.id,
      "color" in icon ? new vscode.ThemeColor(icon.color) : undefined,
    )
    item.description = describe(w)
    item.tooltip = [w.name, w.id, describe(w), w.url].filter((s) => s !== "").join("\n")
    item.contextValue = contextValue(w)
    return item
  }

  // Lists the workspaces again. One asked for while a listing runs is run once that one ends,
  // since that listing may have started before what it was asked for, a start or a stop, landed;
  // every one asked for meanwhile is that same next listing.
  refresh(): Promise<void> {
    if (this.running === undefined) {
      this.running = this.load().finally(() => {
        this.running = undefined
      })
      return this.running
    }
    this.next ??= this.running.then(() => {
      this.next = undefined
      return this.refresh()
    })
    return this.next
  }

  private async load(): Promise<void> {
    try {
      this.items = await this.cli.listWorkspaces()
      this.shownFailure = undefined
      this.setMessage(undefined)
      await setContext("listed")
    } catch (err) {
      if (err instanceof CliError && err.code === "not_signed_in") {
        // The welcome's Sign In is the action: no notification on top of it.
        this.items = []
        this.shownFailure = undefined
        this.setMessage(undefined)
        await setContext("signedOut")
      } else {
        const code = err instanceof CliError ? err.code : "internal"
        this.setMessage(TEXT[code])
        if (this.shownFailure !== code) {
          this.shownFailure = code
          void showCliError(err, () => {
            this.shownFailure = undefined
            return this.refresh()
          })
        }
      }
    }
    this.changed.fire(undefined)
  }
}

function setContext(value: "listed" | "signedOut"): Thenable<unknown> {
  return vscode.commands.executeCommand("setContext", CONTEXT, value)
}

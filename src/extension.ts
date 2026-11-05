import * as vscode from "vscode"
import { COMMANDS } from "./commands"
import { registerOpen } from "./open"

// The commands built so far; the rest answer "not yet" until the task that builds them.
const BUILT: ReadonlySet<string> = new Set(["spinbox.openWorkspace"])

export function activate(context: vscode.ExtensionContext): void {
  registerOpen(context)
  for (const id of COMMANDS) {
    if (BUILT.has(id)) {
      continue
    }
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () =>
        vscode.window.showInformationMessage(`Spinbox: ${id} is not yet available.`),
      ),
    )
  }
}

export function deactivate(): void {}

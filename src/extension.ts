import * as vscode from "vscode"
import { COMMANDS } from "./commands"

// Each command answers "not yet" until the task that builds it.
export function activate(context: vscode.ExtensionContext): void {
  for (const id of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () =>
        vscode.window.showInformationMessage(`Spinbox: ${id} is not yet available.`),
      ),
    )
  }
}

export function deactivate(): void {}

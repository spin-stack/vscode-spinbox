import * as vscode from "vscode"
import { createSpin } from "./cli/vscode"
import { COMMANDS } from "./commands"
import { configureErrors } from "./errors"
import { registerOpen } from "./open"

// The commands built so far; the rest answer "not yet" until the task that builds them.
const BUILT: ReadonlySet<string> = new Set(["spinbox.openWorkspace"])

export function activate(context: vscode.ExtensionContext): void {
  const spin = createSpin(context)
  configureErrors({
    cli: spin.cli,
    output: spin.output,
    extensionVersion: String(context.extension.packageJSON.version),
  })
  registerOpen(context, spin.cli)
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

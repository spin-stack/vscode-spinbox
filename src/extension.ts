import type * as vscode from "vscode"
import { registerAuth } from "./auth"
import { createSpin } from "./cli/vscode"
import { configureErrors } from "./errors"
import { registerOpen } from "./open"

export function activate(context: vscode.ExtensionContext): void {
  const spin = createSpin(context)
  configureErrors({
    cli: spin.cli,
    output: spin.output,
    extensionVersion: String(context.extension.packageJSON.version),
  })
  registerOpen(context, spin.cli)
  registerAuth(context, spin.cli)
}

export function deactivate(): void {}

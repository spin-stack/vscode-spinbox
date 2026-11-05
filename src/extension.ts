import type * as vscode from "vscode"
import { createSpin } from "./cli/vscode"
import { configureErrors } from "./errors"
import { registerOpen } from "./open"
import { registerSignIn } from "./signin"

export function activate(context: vscode.ExtensionContext): void {
  const spin = createSpin(context)
  configureErrors({
    cli: spin.cli,
    output: spin.output,
    extensionVersion: String(context.extension.packageJSON.version),
  })
  registerOpen(context, spin.cli)
  registerSignIn(context, spin.cli)
}

export function deactivate(): void {}

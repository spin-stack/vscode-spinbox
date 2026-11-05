import type * as vscode from "vscode"
import { registerAuth } from "./auth"
import { createSpin } from "./cli/vscode"
import { configureErrors } from "./errors"
import { registerOpen } from "./open"
import { registerStatus } from "./status"
import { registerViews } from "./views"

export function activate(context: vscode.ExtensionContext): void {
  const spin = createSpin(context)
  configureErrors({
    cli: spin.cli,
    output: spin.output,
    binary: spin.binary,
    extensionVersion: String(context.extension.packageJSON.version),
  })
  registerOpen(context, spin.cli)
  const auth = registerAuth(context, spin.cli)
  const tree = registerViews(context, spin.cli)
  // Signing in or out from the Accounts menu changes what the view lists.
  context.subscriptions.push(auth.onDidChangeSessions(() => void tree.refresh()))
  registerStatus(context, spin.cli)
}

export function deactivate(): void {}

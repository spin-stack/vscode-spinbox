import * as vscode from "vscode"

// showCliError shows a failure of the CLI. This stands in for the errors module, which gives each
// code its action and runs retry; until then it shows the message.
export async function showCliError(error: unknown, _retry?: () => unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await vscode.window.showErrorMessage(`Spinbox: ${message}`)
}

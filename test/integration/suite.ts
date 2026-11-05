import * as assert from "node:assert/strict"
import { join } from "node:path"
import * as vscode from "vscode"
import { COMMANDS } from "../../src/commands"

// Run in VS Code's extension host by @vscode/test-electron: a rejection fails the run.
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("spin-stack.spinbox")
  assert.ok(ext, "spin-stack.spinbox is not loaded")
  await ext.activate()
  assert.equal(ext.isActive, true)

  const registered = await vscode.commands.getCommands(true)
  for (const id of COMMANDS) {
    assert.ok(registered.includes(id), `${id} is not registered`)
  }

  // The fake spin's login is the account VS Code's Accounts menu shows for the provider.
  await vscode.workspace
    .getConfiguration("spinbox")
    .update(
      "cliPath",
      join(ext.extensionPath, "test/fake-spin/spin.cjs"),
      vscode.ConfigurationTarget.Global,
    )
  const session = await vscode.authentication.getSession("spinbox", [], { silent: true })
  assert.equal(session?.account.label, "dev@example.com")
}

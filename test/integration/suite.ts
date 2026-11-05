import * as assert from "node:assert/strict"
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
}

import * as vscode from "vscode"
import { trace } from "../telemetry/vscode"
import { SpinBinary } from "./binary"
import { ProcessSpinCli } from "./client"

export interface Spin {
  cli: ProcessSpinCli
  // The 'Spinbox' output channel: each command's exit and the CLI's stderr. Show details opens it.
  output: vscode.OutputChannel
}

// The SpinCli the extension runs: spinbox.cliPath, or the CLI the VSIX carries installed into
// global storage, logging to the 'Spinbox' output channel. The channel is disposed with the
// extension.
export function createSpin(context: vscode.ExtensionContext): Spin {
  const output = vscode.window.createOutputChannel("Spinbox")
  context.subscriptions.push(output)
  const binary = new SpinBinary({
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    cliPath: () => vscode.workspace.getConfiguration("spinbox").get<string>("cliPath", ""),
  })
  const cli = new ProcessSpinCli({
    binary: () => binary.path(),
    log: (text) => output.append(text),
    trace,
  })
  return { cli, output }
}

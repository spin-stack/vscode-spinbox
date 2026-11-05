import * as vscode from "vscode"
import { type Trace, tracer } from "."

// The extension's Trace: on while spinbox.telemetry is and VS Code's own telemetry setting allows
// it, which every extension is asked to respect.
export const trace: Trace = tracer(
  () =>
    vscode.env.isTelemetryEnabled &&
    vscode.workspace.getConfiguration("spinbox").get<boolean>("telemetry", true),
)

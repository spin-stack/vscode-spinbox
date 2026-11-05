import { spawn } from "node:child_process"
import { CliError, type CodeOptions, type RunOptions } from "../cli/client"
import {
  type CodeResult,
  isErrorEnvelope,
  type Workspace,
  type WorkspaceList,
} from "../cli/contract"
import type { OpenCli } from "./open"

// The spin to run: file, then args before the command's own (node and the fake spin in tests).
export interface SpinCommand {
  file: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
}

// spawnOpenCli runs spin as a process for what opening asks of it.
export function spawnOpenCli(spin: SpinCommand): OpenCli {
  return {
    async code(
      workspace: string,
      path: string | undefined,
      vscodeCommit: string,
      opts: CodeOptions = {},
    ): Promise<CodeResult> {
      const args = ["code", workspace]
      if (path !== undefined) {
        args.push(path)
      }
      args.push("--no-open", "--vscode-commit", vscodeCommit)
      if (opts.vscodeVersion !== undefined) {
        args.push("--vscode-version", opts.vscodeVersion)
      }
      if (opts.start === true) {
        args.push("--start")
      }
      return (await runJson(spin, args, opts)) as CodeResult
    },
    async listWorkspaces(opts: RunOptions = {}): Promise<Workspace[]> {
      return ((await runJson(spin, ["workspace", "list"], opts)) as WorkspaceList).items
    },
  }
}

// runJson runs one command with -o json and answers the object on its first line, or rejects
// with the CliError its envelope says. A failure that wrote no envelope is internal, with what
// the process wrote on stderr as its message.
function runJson(spin: SpinCommand, args: string[], opts: RunOptions): Promise<unknown> {
  const all = [...(spin.args ?? []), ...args]
  if (opts.traceparent !== undefined) {
    all.push("--traceparent", opts.traceparent)
  }
  all.push("-o", "json")
  return new Promise((resolve, reject) => {
    const child = spawn(spin.file, all, {
      env: spin.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d
    })
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d
    })
    child.on("error", reject)
    child.on("close", (code) => {
      const line = stdout.split("\n").find((l) => l.trim() !== "")
      let v: unknown
      try {
        v = line === undefined ? undefined : JSON.parse(line)
      } catch {
        v = undefined
      }
      if (isErrorEnvelope(v)) {
        reject(new CliError(v, code ?? 1))
      } else if (code === 0 && typeof v === "object" && v !== null) {
        resolve(v)
      } else {
        const message = stderr.trim() || `spin ${args[0]} exited with ${code ?? "a signal"}`
        reject(new CliError({ error: { code: "internal", action: "details", message } }, code ?? 1))
      }
    })
  })
}

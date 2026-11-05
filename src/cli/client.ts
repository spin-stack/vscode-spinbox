import type {
  CodeResult,
  ErrorCode,
  ErrorEnvelope,
  LoginDone,
  LoginStart,
  VersionResult,
  Workspace,
} from "./contract"

// SpinCli is everything the extension asks of spin: each method runs one command with -o json
// and resolves with its answer, or rejects with a CliError carrying the envelope the CLI wrote.
export interface SpinCli {
  // spin version -o json
  version(opts?: RunOptions): Promise<VersionResult>

  // spin login --no-browser -o json [--endpoint URL]: onStart is called with the first line, which
  // the CLI writes before it waits, and the promise resolves with the second once the login
  // completes. Aborting the signal ends the wait and the process.
  login(onStart: (start: LoginStart) => void, opts?: LoginOptions): Promise<LoginDone>

  // spin workspace list -o json: the items, in the order the CLI wrote them.
  listWorkspaces(opts?: RunOptions): Promise<Workspace[]>

  // spin code <workspace> [path] --no-open --vscode-commit <commit> [--vscode-version X]
  // [--start] -o json
  code(
    workspace: string,
    path: string | undefined,
    vscodeCommit: string,
    opts?: CodeOptions,
  ): Promise<CodeResult>

  // Any other command: args after `spin`, with -o json added. The parsed JSON object it answered.
  run<T>(args: readonly string[], opts?: RunOptions): Promise<T>
}

export interface RunOptions {
  signal?: AbortSignal
  // W3C traceparent the CLI joins (--traceparent).
  traceparent?: string
}

export interface LoginOptions extends RunOptions {
  endpoint?: string
}

export interface CodeOptions extends RunOptions {
  vscodeVersion?: string
  // Start the workspace if it is stopped, rather than failing with workspace_stopped.
  start?: boolean
}

// CliError is a command's failure as the CLI reported it: the envelope it wrote on stdout.
export class CliError extends Error {
  readonly envelope: ErrorEnvelope
  // The process's exit status: 1 for an envelope.
  readonly exitCode: number

  constructor(envelope: ErrorEnvelope, exitCode = 1) {
    super(envelope.error.message)
    this.name = "CliError"
    this.envelope = envelope
    this.exitCode = exitCode
  }

  get code(): ErrorCode {
    return this.envelope.error.code
  }
}

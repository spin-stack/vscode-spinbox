import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { SpinNotFoundError } from "./binary"
import {
  type CodeResult,
  type ErrorCode,
  type ErrorEnvelope,
  isErrorEnvelope,
  type LoginDone,
  type LoginStart,
  type VersionResult,
  type Workspace,
  type WorkspaceList,
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
  // The process's exit status: 1 for an envelope the CLI wrote, otherwise what it exited with, and
  // -1 when it was killed for taking too long.
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

// How long each command may run before its process is killed and it fails as internal. login's
// covers the wait for its first line; once that arrives the wait lasts as long as the code it
// handed out, plus LOGIN_GRACE_MS.
export interface Timeouts {
  version: number
  login: number
  listWorkspaces: number
  // Covers starting a stopped workspace and attaching the editor's server to it.
  code: number
  run: number
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  version: 15_000,
  login: 30_000,
  listWorkspaces: 30_000,
  code: 300_000,
  run: 60_000,
}

const LOGIN_GRACE_MS = 30_000
// Between SIGTERM and SIGKILL, for a CLI that does not stop when asked.
const KILL_GRACE_MS = 3_000

export interface ProcessSpinCliOptions {
  // The spin to run, resolved for each command (SpinBinary.path).
  binary: () => Promise<string>
  // Where each command's exit and stderr go: the Spinbox output channel, which an error's
  // Show details opens.
  log: (text: string) => void
  timeouts?: Partial<Timeouts>
}

interface Exited {
  args: readonly string[]
  lines: string[]
  exit: number | null
  stderr: string
}

// SpinCli over child_process: one spin process per call.
export class ProcessSpinCli implements SpinCli {
  private readonly binary: () => Promise<string>
  private readonly log: (text: string) => void
  private readonly timeouts: Timeouts

  constructor(opts: ProcessSpinCliOptions) {
    this.binary = opts.binary
    this.log = opts.log
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts }
  }

  version(opts: RunOptions = {}): Promise<VersionResult> {
    return this.one(["version"], opts, this.timeouts.version)
  }

  async login(onStart: (start: LoginStart) => void, opts: LoginOptions = {}): Promise<LoginDone> {
    const args = ["login", "--no-browser"]
    if (opts.endpoint !== undefined) {
      args.push("--endpoint", opts.endpoint)
    }
    const r = await this.exec(args, opts, this.timeouts.login, (line, extend) => {
      const start = parse(line)
      if (isLoginStart(start)) {
        extend(start.expires_in * 1000 + LOGIN_GRACE_MS)
        onStart(start)
      }
    })
    const [first, second, ...rest] = r.lines.map(parse)
    if (r.exit === 0 && isLoginStart(first) && isObject(second) && rest.length === 0) {
      return second as unknown as LoginDone
    }
    throw failure(r)
  }

  async listWorkspaces(opts: RunOptions = {}): Promise<Workspace[]> {
    const list = await this.one<WorkspaceList>(
      ["workspace", "list"],
      opts,
      this.timeouts.listWorkspaces,
    )
    if (!Array.isArray(list.items)) {
      throw internal(`spin workspace list answered no items`, 0)
    }
    return list.items
  }

  code(
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
    if (opts.start) {
      args.push("--start")
    }
    return this.one(args, opts, this.timeouts.code)
  }

  run<T>(args: readonly string[], opts: RunOptions = {}): Promise<T> {
    return this.one(args, opts, this.timeouts.run)
  }

  // A command that answers one JSON object.
  private async one<T>(args: readonly string[], opts: RunOptions, timeoutMs: number): Promise<T> {
    const r = await this.exec(args, opts, timeoutMs)
    const [only, ...rest] = r.lines.map(parse)
    if (r.exit === 0 && isObject(only) && !("error" in only) && rest.length === 0) {
      return only as T
    }
    throw failure(r)
  }

  // Runs spin with args, -o json and the traceparent, until it exits. It rejects with the
  // signal's reason when the signal aborts, and with an internal CliError when it outlasts
  // timeoutMs; either way the process is killed first. onLine sees each stdout line as it
  // arrives, and may move the deadline to ms from then.
  private async exec(
    args: readonly string[],
    opts: RunOptions,
    timeoutMs: number,
    onLine?: (line: string, extend: (ms: number) => void) => void,
  ): Promise<Exited> {
    const { signal, traceparent } = opts
    signal?.throwIfAborted()
    const binary = await this.binary()
    signal?.throwIfAborted()
    const argv = [...args, "-o", "json"]
    if (traceparent !== undefined) {
      argv.push("--traceparent", traceparent)
    }
    const shown = `spin ${args.join(" ")}`

    return new Promise<Exited>((resolve, reject) => {
      const child = spawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"] })
      const lines: string[] = []
      const stderr: Buffer[] = []
      let killedFor: unknown
      let settled = false

      const kill = (reason: unknown) => {
        if (killedFor !== undefined || settled) {
          return
        }
        killedFor = reason
        child.kill("SIGTERM")
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL")
          }
        }, KILL_GRACE_MS).unref()
      }
      const deadline = (ms: number) =>
        setTimeout(
          () => kill(internal(`${shown} did not answer within ${Math.round(ms / 1000)} s`, -1)),
          ms,
        )
      let timer = deadline(timeoutMs)
      const extend = (ms: number) => {
        clearTimeout(timer)
        timer = deadline(ms)
      }
      const onAbort = () => kill(signal?.reason)
      signal?.addEventListener("abort", onAbort, { once: true })
      const done = () => {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }

      createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.trim() === "") {
          return
        }
        lines.push(line)
        if (onLine && killedFor === undefined) {
          try {
            onLine(line, extend)
          } catch (err) {
            kill(err)
          }
        }
      })
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) {
          return
        }
        done()
        this.log(`${shown}: ${err.message}\n`)
        reject(
          err.code === "ENOENT" || err.code === "EACCES"
            ? new SpinNotFoundError(`Cannot run spin at ${binary}: ${err.message}`, binary)
            : err,
        )
      })
      child.on("close", (exit, sig) => {
        if (settled) {
          return
        }
        done()
        const text = Buffer.concat(stderr).toString("utf8")
        this.log(`${shown}: ${exit === null ? `killed by ${sig}` : `exit ${exit}`}\n${text}`)
        if (killedFor !== undefined) {
          reject(killedFor)
          return
        }
        resolve({ args, lines, exit, stderr: text })
      })
    })
  }
}

// The CliError a command that did not succeed fails with: the envelope it wrote, or, for anything
// else the contract does not allow, internal with what there is to say about it.
function failure(r: Exited): CliError {
  const parsed = r.lines.map(parse)
  const env = parsed.find(isErrorEnvelope)
  if (env) {
    return new CliError(env, r.exit ?? -1)
  }
  const shown = `spin ${r.args.join(" ")}`
  // An envelope whose code this extension does not know keeps its message, never its action.
  const message = parsed
    .map((v) => (isObject(v) && isObject(v.error) ? v.error.message : undefined))
    .find((m): m is string => typeof m === "string")
  if (message !== undefined) {
    return internal(message, r.exit ?? -1)
  }
  const last = r.stderr.trim().split("\n").at(-1)?.trim()
  const why = r.exit === 0 ? "answered what the contract does not allow" : `exited ${r.exit}`
  return internal(last ? `${shown} ${why}: ${last}` : `${shown} ${why}`, r.exit ?? -1)
}

function internal(message: string, exitCode: number): CliError {
  return new CliError({ error: { code: "internal", action: "details", message } }, exitCode)
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isLoginStart(v: unknown): v is LoginStart {
  return (
    isObject(v) &&
    typeof v.verification_url === "string" &&
    typeof v.user_code === "string" &&
    typeof v.expires_in === "number"
  )
}

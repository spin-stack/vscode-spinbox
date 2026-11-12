import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { type ErrorEnvelope, isErrorEnvelope } from "../cli/contract"

// While Remote-SSH connects, `spin ssh-prepare` and `spin ssh-proxy` - children of its ssh - write
// what happens to that connection to ~/.spin/ssh/status/<ssh pid>.json (spin-stack/spin#1180),
// atomically. Spinbox reads it, says each phase, and shows a refusal with what resolves it, where
// Remote-SSH would show only that ssh exited.

export const STATUS_VERSION = 1

export type ProxyPhase = "resolving" | "connecting" | "connected" | "refused" | "failed"

const PHASES: readonly ProxyPhase[] = ["resolving", "connecting", "connected", "refused", "failed"]

// The CLI's -o json error envelope's error, as written: its code may be one this extension's
// contract does not know yet, so it is not narrowed to ErrorCode here.
export interface ProxyError {
  code: string
  action: string
  message: string
  release?: string
  workspace_id?: string
  url?: string
}

export interface ProxyStatus {
  version: typeof STATUS_VERSION
  host: string
  ssh_pid: number
  phase: ProxyPhase
  // ssh reuses an open connection, and no proxy runs.
  shared?: boolean
  workspace_id?: string
  error?: ProxyError
  started_at: string
  updated_at: string
}

export interface ProxyStatusSource {
  // The status of the connection being made, or undefined while there is none to read.
  read(): Promise<ProxyStatus | undefined>
}

// readProxyStatus parses one status file, or answers undefined for one that is not a status of
// the version this extension reads.
export function readProxyStatus(body: string): ProxyStatus | undefined {
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof v !== "object" || v === null) {
    return undefined
  }
  const s = v as Record<string, unknown>
  if (
    s.version !== STATUS_VERSION ||
    typeof s.host !== "string" ||
    typeof s.ssh_pid !== "number" ||
    !PHASES.includes(s.phase as ProxyPhase) ||
    !isTime(s.started_at) ||
    !isTime(s.updated_at) ||
    (s.error !== undefined && !isProxyError(s.error))
  ) {
    return undefined
  }
  return s as unknown as ProxyStatus
}

function isTime(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v))
}

function isProxyError(v: unknown): v is ProxyError {
  if (typeof v !== "object" || v === null) {
    return false
  }
  const e = v as Record<string, unknown>
  return typeof e.code === "string" && typeof e.action === "string" && typeof e.message === "string"
}

// fileProxyStatus reads, of the status files in dir (~/.spin/ssh/status), the one last updated for
// host whose connection began at or after since: a connection to another workspace, or one made
// before this window's, is never read as its.
export function fileProxyStatus(dir: string, host: string, since: number): ProxyStatusSource {
  return {
    read: async () => {
      let names: string[]
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".json"))
      } catch {
        return undefined
      }
      let newest: ProxyStatus | undefined
      for (const name of names) {
        const s = readProxyStatus(await readFile(join(dir, name), "utf8").catch(() => ""))
        if (
          s !== undefined &&
          s.host === host &&
          Date.parse(s.started_at) >= since &&
          (newest === undefined || Date.parse(s.updated_at) > Date.parse(newest.updated_at))
        ) {
          newest = s
        }
      }
      return newest
    },
  }
}

// What a refused or failed connection shows: the CLI's error, with its action, when its code is one
// the contract knows; otherwise its message, and the page that resolves it when it names one.
export type ProxyFailure = { envelope: ErrorEnvelope } | { message: string; url?: string }

export function proxyFailure(status: ProxyStatus): ProxyFailure | undefined {
  if (status.phase !== "refused" && status.phase !== "failed") {
    return undefined
  }
  const error = status.error
  if (error === undefined) {
    return { message: `Spinbox could not connect to ${status.host}.` }
  }
  const envelope = { error }
  if (isErrorEnvelope(envelope)) {
    return { envelope }
  }
  const message = `Spinbox could not connect to ${status.host}: ${error.message}`
  return error.url === undefined ? { message } : { message, url: error.url }
}

// What each phase on the way says, as the person reads it.
export const SAYS: Record<"resolving" | "connecting", string> = {
  resolving: "finding the workspace",
  connecting: "connecting to the workspace",
}

export interface WatchOptions {
  intervalMs: number
  // How long to read before giving up quietly: Remote-SSH says by then what it has.
  timeoutMs: number
  // Hears each phase on the way, once.
  report(message: string): void
  signal?: AbortSignal
}

// watchProxy reads source every intervalMs until it is connected, refused or failed, and answers
// that status; or undefined at timeoutMs, or once signal aborts.
export async function watchProxy(
  source: ProxyStatusSource,
  opts: WatchOptions,
): Promise<ProxyStatus | undefined> {
  const end = Date.now() + opts.timeoutMs
  let said: ProxyPhase | undefined
  while (opts.signal?.aborted !== true) {
    const status = await source.read()
    if (status !== undefined) {
      if (status.phase !== "resolving" && status.phase !== "connecting") {
        return status
      }
      if (status.phase !== said) {
        said = status.phase
        opts.report(SAYS[status.phase])
      }
    }
    if (Date.now() >= end) {
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs))
  }
  return undefined
}

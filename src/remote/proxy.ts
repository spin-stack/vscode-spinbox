import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { type ErrorEnvelope, isErrorEnvelope } from "../cli/contract"

// While Remote-SSH connects, `spin ssh-proxy` carries the connection, and writes what happens to
// it - connecting, connected, or why it failed - to a status file of that connection. Spinbox reads
// it, says each step under the connecting notification, and shows a failure with what resolves it,
// where Remote-SSH would show only that ssh exited.
//
// The file is spin's (branch ssh-proxy-status): its layout and schema here are provisional until
// that lands, and change in readProxyStatus and fileProxyStatus alone.

export type ProxyState = "connecting" | "connected" | "failed"

export interface ProxyStatus {
  state: ProxyState
  // What is happening, or what failed, as the person reads it.
  message: string
  // A failure the CLI has a code for, with its action.
  error?: ErrorEnvelope["error"]
}

export interface ProxyStatusSource {
  // The status of the connection being made, or undefined while there is none to read.
  read(): Promise<ProxyStatus | undefined>
}

const STATES: readonly ProxyState[] = ["connecting", "connected", "failed"]

// readProxyStatus parses one status file's body, or answers undefined for one that is not a
// status - half written, or another file.
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
  const { state, message } = v as { state?: unknown; message?: unknown }
  if (!STATES.includes(state as ProxyState) || typeof message !== "string") {
    return undefined
  }
  const status: ProxyStatus = { state: state as ProxyState, message }
  if (isErrorEnvelope(v)) {
    status.error = v.error
  }
  return status
}

// fileProxyStatus reads the newest *.status file in dir - ~/.spin/ssh/hosts/<host>/, where
// ssh-prepare leaves its session - written at or after since, so a connection made before this one
// is never read as its.
export function fileProxyStatus(dir: string, since: number): ProxyStatusSource {
  return {
    read: async () => {
      let names: string[]
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".status"))
      } catch {
        return undefined
      }
      let newest: { at: number; path: string } | undefined
      for (const name of names) {
        const path = join(dir, name)
        const at = (await stat(path).catch(() => undefined))?.mtimeMs
        if (at !== undefined && at >= since && (newest === undefined || at > newest.at)) {
          newest = { at, path }
        }
      }
      if (newest === undefined) {
        return undefined
      }
      return readProxyStatus(await readFile(newest.path, "utf8").catch(() => ""))
    },
  }
}

export interface WatchOptions {
  intervalMs: number
  // How long to read before giving up quietly: Remote-SSH says by then what it has.
  timeoutMs: number
  // Hears each new message while connecting.
  report(message: string): void
  signal?: AbortSignal
}

// watchProxy reads source every intervalMs until it says connected or failed, and answers that
// status; or undefined at timeoutMs, or once signal aborts.
export async function watchProxy(
  source: ProxyStatusSource,
  opts: WatchOptions,
): Promise<ProxyStatus | undefined> {
  const end = Date.now() + opts.timeoutMs
  let said: string | undefined
  while (opts.signal?.aborted !== true) {
    const status = await source.read()
    if (status !== undefined && status.state !== "connecting") {
      return status
    }
    if (status !== undefined && status.message !== said) {
      said = status.message
      opts.report(status.message)
    }
    if (Date.now() >= end) {
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs))
  }
  return undefined
}

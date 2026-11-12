import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  fileProxyStatus,
  type ProxyStatus,
  type ProxyStatusSource,
  proxyFailure,
  readProxyStatus,
  SAYS,
  watchProxy,
} from "../../src/remote/proxy"

const HOST = "spin.my-ws"
const T0 = Date.parse("2026-11-12T22:00:00Z")
const at = (ms: number) => new Date(T0 + ms).toISOString()

// A status file as spin#1180 writes it, version 1: shared, workspace_id and error left out when
// they have no value.
function status(phase: ProxyStatus["phase"], o: Partial<ProxyStatus> = {}): ProxyStatus {
  return {
    version: 1,
    host: HOST,
    ssh_pid: 4242,
    phase,
    started_at: at(0),
    updated_at: at(1),
    ...o,
  }
}

const KEY_NOT_ENROLLED = {
  code: "key_not_enrolled",
  message: "this machine's key is not enrolled",
  action: "add_key",
  url: "https://app.spinbox.test/settings/keys",
}

// A source that answers each status in turn, then the last one again.
function fixture(...statuses: (ProxyStatus | undefined)[]): ProxyStatusSource {
  let i = 0
  return { read: async () => statuses[Math.min(i++, statuses.length - 1)] }
}

describe("readProxyStatus", () => {
  it("reads a refusal with the CLI's error envelope", () => {
    const body = JSON.stringify({
      version: 1,
      host: HOST,
      ssh_pid: 4242,
      phase: "refused",
      workspace_id: "ws-1",
      error: KEY_NOT_ENROLLED,
      started_at: "2026-11-12T22:00:00.123456789Z",
      updated_at: "2026-11-12T22:00:01.5Z",
    })
    expect(readProxyStatus(body)?.error).toEqual(KEY_NOT_ENROLLED)
  })

  it("reads a shared connection", () => {
    expect(readProxyStatus(JSON.stringify(status("connected", { shared: true })))).toEqual(
      status("connected", { shared: true }),
    )
  })

  it.each([
    ["another version", { ...status("connected"), version: 2 }],
    ["no version", { ...status("connected"), version: undefined }],
    ["an unknown phase", { ...status("connected"), phase: "maybe" }],
    ["no host", { ...status("connected"), host: undefined }],
    ["no pid", { ...status("connected"), ssh_pid: "4242" }],
    ["a time that is no time", { ...status("connected"), updated_at: "soon" }],
    ["an error that is no envelope", { ...status("refused"), error: { code: "x" } }],
  ])("is nothing for %s", (_what, v) => {
    expect(readProxyStatus(JSON.stringify(v))).toBeUndefined()
  })

  it("is nothing for a file that is not JSON", () => {
    expect(readProxyStatus('{"version": 1, "ho')).toBeUndefined()
  })
})

describe("fileProxyStatus", () => {
  function dir(files: Record<string, unknown>): string {
    const d = mkdtempSync(join(tmpdir(), "proxy-status-"))
    for (const [name, v] of Object.entries(files)) {
      writeFileSync(join(d, name), typeof v === "string" ? v : JSON.stringify(v))
    }
    return d
  }

  it("reads the window's host's connection, last updated, begun since the window began", async () => {
    const d = dir({
      "100.json": status("failed", {
        ssh_pid: 100,
        started_at: at(-60_000),
        updated_at: at(-59_000),
      }),
      "200.json": status("connected", { ssh_pid: 200, host: "spin.other", updated_at: at(9_000) }),
      "300.json": status("resolving", { ssh_pid: 300, updated_at: at(1_000) }),
      "400.json": status("connecting", { ssh_pid: 400, updated_at: at(2_000) }),
      "500.json": { ...status("connected", { ssh_pid: 500, updated_at: at(8_000) }), version: 2 },
      "notes.txt": "not a status",
    })
    expect((await fileProxyStatus(d, HOST, T0).read())?.ssh_pid).toBe(400)
  })

  it("is nothing before any connection of the host is written", async () => {
    const d = dir({ "100.json": status("failed", { started_at: at(-1) }) })
    expect(await fileProxyStatus(d, HOST, T0).read()).toBeUndefined()
  })

  it("is nothing for a directory that is not there", async () => {
    expect(await fileProxyStatus(join(tmpdir(), "no-such-status"), HOST, 0).read()).toBeUndefined()
  })
})

describe("proxyFailure", () => {
  it("is the CLI's envelope for a code the contract knows", () => {
    const error = { code: "no_capacity", action: "retry", message: "full" }
    expect(proxyFailure(status("failed", { error }))).toEqual({ envelope: { error } })
  })

  it("is the message and its page for a code the contract does not know", () => {
    expect(proxyFailure(status("refused", { error: KEY_NOT_ENROLLED }))).toEqual({
      message: `Spinbox could not connect to ${HOST}: ${KEY_NOT_ENROLLED.message}`,
      url: KEY_NOT_ENROLLED.url,
    })
  })

  it("names the host when there is no error", () => {
    expect(proxyFailure(status("failed"))).toEqual({
      message: `Spinbox could not connect to ${HOST}.`,
    })
  })

  it.each(["resolving", "connecting", "connected"] as const)("is nothing while %s", (phase) => {
    expect(proxyFailure(status(phase))).toBeUndefined()
  })
})

describe("watchProxy", () => {
  const opts = (said: string[]) => ({
    intervalMs: 1,
    timeoutMs: 1_000,
    report: (m: string) => said.push(m),
  })

  it("says each phase once, and answers the refusal", async () => {
    const said: string[] = []
    const refused = status("refused", { error: KEY_NOT_ENROLLED })
    const got = await watchProxy(
      fixture(
        undefined,
        status("resolving"),
        status("resolving"),
        status("connecting"),
        status("connecting"),
        refused,
      ),
      opts(said),
    )
    expect(got).toEqual(refused)
    expect(said).toEqual([SAYS.resolving, SAYS.connecting])
  })

  it.each(["connected", "failed"] as const)("answers %s", async (phase) => {
    expect((await watchProxy(fixture(status(phase)), opts([])))?.phase).toBe(phase)
  })

  it("gives up quietly when nothing is written", async () => {
    const said: string[] = []
    expect(await watchProxy(fixture(undefined), { ...opts(said), timeoutMs: 20 })).toBeUndefined()
    expect(said).toEqual([])
  })
})

import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  fileProxyStatus,
  type ProxyStatus,
  type ProxyStatusSource,
  readProxyStatus,
  watchProxy,
} from "../../src/remote/proxy"

// A source that answers each status in turn, then the last one again.
function fixture(...statuses: (ProxyStatus | undefined)[]): ProxyStatusSource {
  let i = 0
  return { read: async () => statuses[Math.min(i++, statuses.length - 1)] }
}

const connecting = (message: string): ProxyStatus => ({ state: "connecting", message })

describe("readProxyStatus", () => {
  it("reads a failure with the CLI's error", () => {
    const body = JSON.stringify({
      state: "failed",
      message: "refused",
      error: { code: "no_key_held", action: "add_key", message: "no key" },
    })
    expect(readProxyStatus(body)).toEqual({
      state: "failed",
      message: "refused",
      error: { code: "no_key_held", action: "add_key", message: "no key" },
    })
  })

  it.each([
    ["half written", '{"state": "conn'],
    ["an unknown state", JSON.stringify({ state: "maybe", message: "x" })],
    ["no message", JSON.stringify({ state: "connected" })],
    ["not an object", "3"],
  ])("is nothing for %s", (_what, body) => {
    expect(readProxyStatus(body)).toBeUndefined()
  })
})

describe("fileProxyStatus", () => {
  it("reads the newest status written since the connection began", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-"))
    const since = Date.now()
    const write = (name: string, status: ProxyStatus, at: number) => {
      writeFileSync(join(dir, name), JSON.stringify(status))
      utimesSync(join(dir, name), at / 1000, at / 1000)
    }
    write("100.status", { state: "failed", message: "an earlier connection" }, since - 60_000)
    expect(await fileProxyStatus(dir, since).read()).toBeUndefined()
    write("200.status", connecting("relay"), since + 1_000)
    write("300.status", { state: "connected", message: "up" }, since + 2_000)
    writeFileSync(join(dir, "300.tunnel"), "not a status")
    expect(await fileProxyStatus(dir, since).read()).toEqual({ state: "connected", message: "up" })
  })

  it("is nothing for a directory that is not there", async () => {
    expect(await fileProxyStatus(join(tmpdir(), "no-such-dir-x"), 0).read()).toBeUndefined()
  })
})

describe("watchProxy", () => {
  const opts = (said: string[]) => ({
    intervalMs: 1,
    timeoutMs: 1_000,
    report: (m: string) => said.push(m),
  })

  it("says each new step, and answers the failure", async () => {
    const said: string[] = []
    const failed: ProxyStatus = { state: "failed", message: "refused" }
    const got = await watchProxy(
      fixture(undefined, connecting("relay"), connecting("relay"), connecting("sshd"), failed),
      opts(said),
    )
    expect(got).toEqual(failed)
    expect(said).toEqual(["relay", "sshd"])
  })

  it("answers connected", async () => {
    const got = await watchProxy(fixture({ state: "connected", message: "up" }), opts([]))
    expect(got?.state).toBe("connected")
  })

  it("gives up quietly when nothing is written", async () => {
    const said: string[] = []
    const got = await watchProxy(fixture(undefined), { ...opts(said), timeoutMs: 20 })
    expect(got).toBeUndefined()
    expect(said).toEqual([])
  })
})

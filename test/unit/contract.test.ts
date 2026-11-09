import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ACTION_OF, ERROR_CODES, isErrorEnvelope } from "../../src/cli/contract"
import { runFake } from "./fake-spin"

describe("error envelopes", () => {
  it.each(ERROR_CODES)("%s fails with exit 1, one envelope, and the table's action", (code) => {
    const r = runFake(["workspace", "list", "-o", "json"], { FAKE_SPIN_ERROR: code })
    expect(r.exit).toBe(1)
    expect(r.docs).toHaveLength(1)
    const [env] = r.docs
    expect(isErrorEnvelope(env)).toBe(true)
    expect(env).toMatchObject({ error: { code, action: ACTION_OF[code] } })
  })

  it("rejects what is not an envelope of the contract", () => {
    for (const v of [
      null,
      "error",
      { error: null },
      { error: { code: "internal", message: "m" } },
      { error: { code: "teapot", action: "details", message: "m" } },
      { error: { code: "internal", action: "reboot", message: "m" } },
      { error: { code: "internal", action: "details" } },
    ]) {
      expect(isErrorEnvelope(v)).toBe(false)
    }
  })
})

describe("fake spin", () => {
  it("answers each command with the contract's shape", () => {
    expect(runFake(["version", "-o", "json"]).docs).toEqual([
      expect.objectContaining({ cli: expect.any(String), signed_in: true }),
    ])
    expect(runFake(["login", "--no-browser", "-o", "json"]).docs).toEqual([
      expect.objectContaining({ user_code: "ABCD-EFGH", expires_in: 600 }),
      expect.objectContaining({ profile: "default", user: expect.any(Object) }),
    ])
    expect(runFake(["workspace", "list", "-o", "json"]).docs).toEqual([
      { items: [expect.objectContaining({ id: "ws-1", state: "WORKSPACE_STATE_RUNNING" })] },
    ])
    expect(
      runFake(["code", "my-ws", "--no-open", "--vscode-commit", "a".repeat(40), "-o", "json"]).docs,
    ).toEqual([expect.objectContaining({ host: "spin.my-ws", server: "carried" })])
  })

  // What spin's cmd/cli/cmd/output.go does: emit indents, emitLine (login) writes JSON Lines.
  it("writes documents the way the real CLI does", () => {
    expect(runFake(["version", "-o", "json"]).stdout).toMatch(/^\{\n {2}"cli": /)
    expect(runFake(["login", "--no-browser", "-o", "json"]).stdout.split("\n")).toEqual([
      expect.stringMatching(/^\{"verification_url":.*\}$/),
      expect.stringMatching(/^\{"profile":.*\}$/),
      "",
    ])
  })

  it("answers a scenario file per command, the rest by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-spin-"))
    const scenario = join(dir, "scenario.json")
    writeFileSync(
      scenario,
      JSON.stringify({
        code: { error: "access_needs_signature", url: "https://app.spinbox.test/sign/ws-1" },
      }),
    )
    const env = { FAKE_SPIN_SCENARIO: scenario }
    const r = runFake(["code", "my-ws", "-o", "json"], env)
    expect(r.exit).toBe(1)
    expect(r.docs).toEqual([
      {
        error: {
          code: "access_needs_signature",
          action: "sign",
          message: "fake access_needs_signature",
          url: "https://app.spinbox.test/sign/ws-1",
        },
      },
    ])
    expect(runFake(["version", "-o", "json"], env).exit).toBe(0)
  })

  it("refuses a command run without -o json", () => {
    expect(runFake(["version"]).exit).toBe(2)
  })
})

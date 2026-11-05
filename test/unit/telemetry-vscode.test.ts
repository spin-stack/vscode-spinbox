import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProcessSpinCli } from "../../src/cli/client"
import { BUTTON, configureErrors, showCliError } from "../../src/errors"
import { traceIdOf } from "../../src/telemetry"
import { trace } from "../../src/telemetry/vscode"
import { FAKE_SPIN } from "./fake-spin"

const vs = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  env: { isTelemetryEnabled: true },
  showErrorMessage: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: unknown) => vs.settings[`${section}.${key}`] ?? fallback,
    }),
  },
  window: { showErrorMessage: vs.showErrorMessage },
  env: {
    get isTelemetryEnabled() {
      return vs.env.isTelemetryEnabled
    },
    clipboard: { writeText: vs.writeText },
  },
  version: "1.120.0",
}))

beforeEach(() => {
  vi.resetAllMocks()
  vs.settings = {}
  vs.env.isTelemetryEnabled = true
})

afterEach(() => {
  vi.unstubAllEnvs()
  configureErrors(undefined)
})

// The extension's ProcessSpinCli, as createSpin builds it, against the fake spin; and the
// traceparent of each invocation it ran (undefined for none).
function extensionSpin(): { cli: ProcessSpinCli; traceparents: () => (string | undefined)[] } {
  const log = join(mkdtempSync(join(tmpdir(), "telemetry-vscode-")), "log")
  writeFileSync(log, "")
  vi.stubEnv("FAKE_SPIN_LOG", log)
  const cli = new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {}, trace })
  return {
    cli,
    traceparents: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const argv = JSON.parse(l) as string[]
          const i = argv.indexOf("--traceparent")
          return i === -1 ? undefined : argv[i + 1]
        }),
  }
}

describe("spinbox.telemetry", () => {
  it("on by default: the CLI is handed a traceparent", async () => {
    const s = extensionSpin()
    await s.cli.version()
    expect(s.traceparents()).toEqual([expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)])
  })

  it("false: the CLI is handed none", async () => {
    vs.settings["spinbox.telemetry"] = false
    const s = extensionSpin()
    await s.cli.version()
    await s.cli.login(() => {})
    expect(s.traceparents()).toEqual([undefined, undefined])
  })

  it("VS Code's telemetry off: the CLI is handed none", async () => {
    vs.env.isTelemetryEnabled = false
    const s = extensionSpin()
    await s.cli.version()
    expect(s.traceparents()).toEqual([undefined])
  })
})

describe("Copy Diagnostics", () => {
  it("includes the trace-id of the command that failed", async () => {
    const s = extensionSpin()
    configureErrors({
      cli: s.cli,
      output: { appendLine: vi.fn(), show: vi.fn() },
      binary: () => Promise.resolve(FAKE_SPIN),
      extensionVersion: "0.0.1",
    })
    vi.stubEnv("FAKE_SPIN_ERROR", "internal")
    const err = await s.cli.code("ws-1", undefined, "a".repeat(40)).catch((e: unknown) => e)
    const failed = traceIdOf(s.traceparents()[0])
    expect(failed).toMatch(/^[0-9a-f]{32}$/)
    vs.showErrorMessage.mockResolvedValueOnce(BUTTON.copy)
    await showCliError(err)
    expect(String(vs.writeText.mock.calls[0]?.[0])).toContain(`trace: ${failed}`)
  })

  it("says none for a failure that ran in no trace", async () => {
    configureErrors({
      cli: { run: vi.fn(), version: vi.fn().mockRejectedValue(new Error("x")) },
      output: { appendLine: vi.fn(), show: vi.fn() },
      binary: () => Promise.resolve(FAKE_SPIN),
      extensionVersion: "0.0.1",
    })
    vs.showErrorMessage.mockResolvedValueOnce(BUTTON.copy)
    await showCliError(new Error("boom"))
    expect(String(vs.writeText.mock.calls[0]?.[0])).toContain("trace: none")
  })
})

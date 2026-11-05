import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, ProcessSpinCli } from "../../src/cli/client"
import { type OpenDeps, openWorkspace, pickAndOpen } from "../../src/open/open"
import { newTraceparent, traceIdOf, tracer } from "../../src/telemetry"
import { FAKE_SPIN } from "./fake-spin"

// W3C Trace Context, version 00: trace-id and parent-id lowercase hex, neither all zeros.
const W3C = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/

afterEach(() => {
  vi.unstubAllEnvs()
})

// A FAKE_SPIN_LOG for the test, and what each invocation passed as --traceparent (undefined for
// none).
function logged(): { traceparents: () => (string | undefined)[] } {
  const log = join(mkdtempSync(join(tmpdir(), "telemetry-")), "log")
  writeFileSync(log, "")
  vi.stubEnv("FAKE_SPIN_LOG", log)
  return {
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

function spin(enabled: boolean): ProcessSpinCli {
  return new ProcessSpinCli({
    binary: () => Promise.resolve(FAKE_SPIN),
    log: () => {},
    trace: tracer(() => enabled),
  })
}

// Every command the extension runs, once each.
async function everyCommand(cli: ProcessSpinCli): Promise<void> {
  await cli.version()
  await cli.login(() => {})
  await cli.listWorkspaces()
  await cli.code("ws-1", undefined, "a".repeat(40))
  await cli.run(["workspace", "stop", "ws-1"])
}

function openDeps(cli: ProcessSpinCli, enabled: boolean): OpenDeps {
  return {
    cli,
    ui: {
      progress: (_title, task) => task(new AbortController().signal),
      pick: async (ws) => ws[0],
      openFolder: async () => {},
      showCliError: () => {},
      showError: () => {},
    },
    commit: async () => "a".repeat(40),
    vscodeVersion: "1.120.0",
    trace: tracer(() => enabled),
  }
}

describe("newTraceparent", () => {
  it("is a valid W3C traceparent, sampled, new each time", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const tp = newTraceparent()
      expect(tp).toMatch(W3C)
      expect(tp.endsWith("-01")).toBe(true)
      seen.add(traceIdOf(tp) ?? "")
    }
    expect(seen.size).toBe(100)
  })

  it("traceIdOf reads the trace-id, and nothing from what is not a traceparent", () => {
    const id = "4bf92f3577b34da6a3ce929d0e0e4736"
    expect(traceIdOf(`00-${id}-00f067aa0ba902b7-01`)).toBe(id)
    expect(traceIdOf("not-a-traceparent")).toBeUndefined()
    expect(traceIdOf(undefined)).toBeUndefined()
  })
})

describe("the CLI is handed the trace", () => {
  it("with telemetry on, every command runs with --traceparent in a trace of its own", async () => {
    const log = logged()
    await everyCommand(spin(true))
    const tps = log.traceparents()
    expect(tps).toHaveLength(5)
    for (const tp of tps) {
      expect(tp).toMatch(W3C)
    }
    expect(new Set(tps.map(traceIdOf)).size).toBe(5)
  })

  it("with telemetry off, no command is handed --traceparent", async () => {
    const log = logged()
    await everyCommand(spin(false))
    expect(log.traceparents()).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it("a traceparent the caller passes is the one the CLI gets", async () => {
    const log = logged()
    const tp = newTraceparent()
    await spin(true).version({ traceparent: tp })
    expect(log.traceparents()).toEqual([tp])
  })

  it("a failed command's CliError carries the traceparent it ran with", async () => {
    const log = logged()
    vi.stubEnv("FAKE_SPIN_ERROR", "internal")
    const err = await spin(true)
      .listWorkspaces()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).traceparent).toBe(log.traceparents()[0])
    expect((err as CliError).traceparent).toMatch(W3C)
  })

  it("opening a workspace hands spin code a trace", async () => {
    const log = logged()
    await openWorkspace(openDeps(spin(false), true), { workspace: "ws-1" })
    expect(log.traceparents()).toEqual([expect.stringMatching(W3C)])
  })

  it("picking and opening is one trace: the listing and spin code share it", async () => {
    const log = logged()
    await pickAndOpen(openDeps(spin(false), true))
    const [list, code] = log.traceparents()
    expect(list).toMatch(W3C)
    expect(code).toBe(list)
  })

  it("with telemetry off, opening hands spin no trace", async () => {
    const log = logged()
    await pickAndOpen(openDeps(spin(false), false))
    expect(log.traceparents()).toEqual([undefined, undefined])
  })
})

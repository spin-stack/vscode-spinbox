// The extension's reader against the real spin CLI of the pinned release, the one every VSIX
// carries: task package:spin puts it in build/spin/<target>/spin, and task test:cli runs this
// after it. The fake spin answers as the contract says; this holds the contract to what the CLI
// writes, for the answers it gives with no installation at all.
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { targetDir } from "../../src/cli/binary"
import { CliError, ProcessSpinCli } from "../../src/cli/client"

const target = targetDir(process.platform, process.arch)
const SPIN = resolve(import.meta.dirname, "../../build/spin", target ?? "unsupported", "spin")

beforeEach(() => {
  if (!existsSync(SPIN)) {
    throw new Error(`no spin CLI at ${SPIN}: run go tool task package:spin first`)
  }
  // No profile and no installation: a home of its own, and none of the caller's SPIN_*.
  const home = mkdtempSync(join(tmpdir(), "spin-home-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
  for (const name of Object.keys(process.env).filter((n) => n.startsWith("SPIN_"))) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function cli(): ProcessSpinCli {
  return new ProcessSpinCli({ binary: () => Promise.resolve(SPIN), log: () => {} })
}

async function rejection(p: Promise<unknown>): Promise<CliError> {
  try {
    await p
  } catch (err) {
    if (err instanceof CliError) {
      return err
    }
    throw err
  }
  throw new Error("resolved")
}

describe("the pinned spin CLI", () => {
  it("answers version, signed out, as one document", async () => {
    await expect(cli().version()).resolves.toMatchObject({
      cli: expect.stringMatching(/^v\d{8}\.\d{2}$/),
      profile: "default",
      signed_in: false,
    })
  })

  it.each([
    ["workspace list", (c: ProcessSpinCli) => c.listWorkspaces(), "not_signed_in", "login"],
    [
      "code",
      (c: ProcessSpinCli) => c.code("my-ws", undefined, "a".repeat(40)),
      "not_signed_in",
      "login",
    ],
    [
      "login, its endpoint unreachable",
      (c: ProcessSpinCli) => c.login(() => {}, { endpoint: "http://127.0.0.1:1" }),
      "unreachable",
      "retry",
    ],
  ])("fails %s with its envelope", async (_, run, code, action) => {
    const err = await rejection(run(cli()))
    expect(err.exitCode).toBe(1)
    expect(err.envelope).toEqual({
      error: { code, action, message: expect.any(String) },
    })
  })
})

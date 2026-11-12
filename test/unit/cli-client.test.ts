import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SpinNotFoundError } from "../../src/cli/binary"
import { CliError, ProcessSpinCli, type Timeouts } from "../../src/cli/client"
import { ACTION_OF, ERROR_CODES } from "../../src/cli/contract"
import { FAKE_SPIN } from "./fake-spin"

afterEach(() => {
  vi.unstubAllEnvs()
})

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "spin-cli-"))
}

function cli(timeouts: Partial<Timeouts> = {}, binary = FAKE_SPIN) {
  const log: string[] = []
  const c = new ProcessSpinCli({
    binary: () => Promise.resolve(binary),
    log: (t) => log.push(t),
    timeouts,
  })
  return { cli: c, log }
}

function scenario(answers: object): void {
  const file = join(tmp(), "scenario.json")
  writeFileSync(file, JSON.stringify(answers))
  vi.stubEnv("FAKE_SPIN_SCENARIO", file)
}

// The fake spin behind a shell that writes its pid first, so a test can see the process is gone.
function pidSpin(): { binary: string; pids: () => number[] } {
  const dir = tmp()
  const pidFile = join(dir, "pids")
  const binary = join(dir, "spin")
  writeFileSync(binary, `#!/bin/sh\necho $$ >> "${pidFile}"\nexec node "${FAKE_SPIN}" "$@"\n`)
  chmodSync(binary, 0o755)
  return {
    binary,
    pids: () => readFileSync(pidFile, "utf8").trim().split("\n").map(Number),
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error("resolved")
}

describe("ProcessSpinCli answers", () => {
  it("runs each command with -o json and returns what it answered", async () => {
    const logFile = join(tmp(), "argv")
    vi.stubEnv("FAKE_SPIN_LOG", logFile)
    const { cli: c } = cli()
    await expect(c.version()).resolves.toMatchObject({ signed_in: true, profile: "default" })
    await expect(c.listWorkspaces()).resolves.toEqual([expect.objectContaining({ id: "ws-1" })])
    const commit = "a".repeat(40)
    await expect(
      c.code("my-ws", "/root", commit, { vscodeVersion: "1.120.0", start: true }),
    ).resolves.toMatchObject({ host: "spin.my-ws", server: "carried" })
    await expect(c.run(["workspace", "stop", "my-ws"])).resolves.toEqual({})
    const argv = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[])
    expect(argv).toEqual([
      ["version", "-o", "json"],
      ["workspace", "list", "-o", "json"],
      [
        "code",
        "my-ws",
        "/root",
        "--no-open",
        "--vscode-commit",
        commit,
        "--vscode-version",
        "1.120.0",
        "--start",
        "-o",
        "json",
      ],
      ["workspace", "stop", "my-ws", "-o", "json"],
    ])
  })

  it("passes --traceparent when given one", async () => {
    const logFile = join(tmp(), "argv")
    vi.stubEnv("FAKE_SPIN_LOG", logFile)
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    await cli().cli.version({ traceparent: tp })
    expect(JSON.parse(readFileSync(logFile, "utf8"))).toEqual([
      "version",
      "-o",
      "json",
      "--traceparent",
      tp,
    ])
  })

  it("hands login's first line over before the login completes", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "300")
    const seen: string[] = []
    const done = await cli().cli.login((start) => seen.push(`start ${start.user_code}`), {
      endpoint: "https://app.spinbox.test",
    })
    seen.push(`done ${done.user.email}`)
    expect(seen).toEqual(["start ABCD-EFGH", "done dev@example.com"])
  })
})

describe("ProcessSpinCli failures", () => {
  it.each(ERROR_CODES)("%s arrives as a CliError with its envelope", async (code) => {
    vi.stubEnv("FAKE_SPIN_ERROR", code)
    for (const call of [
      (c: ProcessSpinCli) => c.listWorkspaces(),
      (c: ProcessSpinCli) => c.login(() => {}),
    ]) {
      const err = await rejection(call(cli().cli))
      expect(err).toBeInstanceOf(CliError)
      const e = err as CliError
      expect(e.code).toBe(code)
      expect(e.envelope.error.action).toBe(ACTION_OF[code])
      expect(e.message).toBe(`fake ${code}`)
      expect(e.exitCode).toBe(1)
    }
  })

  it("keeps the envelope's fields", async () => {
    scenario({ code: { error: "key_not_enrolled", url: "https://app.spinbox.test/settings/keys" } })
    const e = (await rejection(cli().cli.code("my-ws", undefined, "a".repeat(40)))) as CliError
    expect(e.envelope.error).toMatchObject({
      code: "key_not_enrolled",
      url: expect.any(String),
    })
  })

  it("reads an envelope with an action the contract does not pair as internal", async () => {
    scenario({ version: { error: "no_capacity", action: "reboot", message: "no host" } })
    const e = (await rejection(cli().cli.version())) as CliError
    expect(e).toBeInstanceOf(CliError)
    expect(e.code).toBe("internal")
    expect(e.envelope.error.action).toBe("details")
    expect(e.message).toBe("no host")
  })

  it("fails as internal with the last stderr line when there is no envelope, and logs stderr", async () => {
    scenario({ version: { stdout: [], stderr: "panic: nil map\ngoroutine 1\n", exit: 2 } })
    const { cli: c, log } = cli()
    const e = (await rejection(c.version())) as CliError
    expect(e.code).toBe("internal")
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain("goroutine 1")
    expect(log.join("")).toContain("panic: nil map")
  })

  it("fails as internal when a success answers more than one object", async () => {
    scenario({ version: { stdout: [{}, {}] } })
    const e = (await rejection(cli().cli.version())) as CliError
    expect(e.code).toBe("internal")
  })

  it("fails with SpinNotFoundError when the binary is not there", async () => {
    const err = await rejection(cli({}, join(tmp(), "nope")).cli.version())
    expect(err).toBeInstanceOf(SpinNotFoundError)
  })
})

describe("ProcessSpinCli kills a hung spin", () => {
  it("on its timeout", async () => {
    scenario({ version: { delayMs: 60_000 } })
    const spin = pidSpin()
    const started = Date.now()
    const e = (await rejection(cli({ version: 300 }, spin.binary).cli.version())) as CliError
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(e).toBeInstanceOf(CliError)
    expect(e.code).toBe("internal")
    expect(e.exitCode).toBe(-1)
    expect(spin.pids().map(alive)).toEqual([false])
  })

  it("on cancellation", async () => {
    scenario({ "workspace list": { delayMs: 60_000 } })
    const spin = pidSpin()
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const err = await rejection(cli({}, spin.binary).cli.listWorkspaces({ signal: ac.signal }))
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe("AbortError")
    expect(spin.pids().map(alive)).toEqual([false])
  })

  it("on cancellation while login waits for its second line", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "60000")
    const spin = pidSpin()
    const ac = new AbortController()
    const err = await rejection(
      cli({ login: 60_000 }, spin.binary).cli.login(() => ac.abort(), { signal: ac.signal }),
    )
    expect((err as DOMException).name).toBe("AbortError")
    expect(spin.pids().map(alive)).toEqual([false])
  })

  it("whose child holds its stdout open", async () => {
    const binary = join(tmp(), "spin")
    writeFileSync(binary, "#!/bin/sh\nsleep 20 &\nexec sleep 20\n")
    chmodSync(binary, 0o755)
    const started = Date.now()
    const e = (await rejection(cli({ version: 300 }, binary).cli.version())) as CliError
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(e.code).toBe("internal")
  })

  it("not when it answered and a child it left running holds its stdout open", async () => {
    const binary = join(tmp(), "spin")
    writeFileSync(
      binary,
      `#!/bin/sh\nsleep 20 &\necho '{"cli":"v20261105.01","profile":"default","endpoint":"e","signed_in":true}'\n`,
    )
    chmodSync(binary, 0o755)
    const started = Date.now()
    await expect(cli({ version: 10_000 }, binary).cli.version()).resolves.toMatchObject({
      cli: "v20261105.01",
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  // A server being prepared takes minutes once; each step it says moves code's deadline, and is
  // heard as it comes. The steps are not the answer: the result after them is.
  it("not while a server is being prepared and says so", async () => {
    const step = (s: string) => ({
      preparing: { vscode_version: "1.120.0", vscode_commit: "a".repeat(40), step: s },
    })
    scenario({
      code: {
        lineDelayMs: 1000,
        stdout: [
          step("downloading"),
          step("building"),
          {
            workspace_id: "ws-1",
            host: "spin.my-ws",
            folder_uri: "vscode-remote://x",
            server: "carried",
          },
        ],
      },
    })
    const heard: string[] = []
    await expect(
      cli({ code: 1500 }).cli.code("my-ws", undefined, "a".repeat(40), {
        onPreparing: (p) => heard.push(p.step),
      }),
    ).resolves.toMatchObject({ server: "carried" })
    expect(heard).toEqual(["downloading", "building"])
  }, 10_000)

  it("not while login waits within the code's lifetime", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "3000")
    await expect(cli({ login: 1500 }).cli.login(() => {})).resolves.toMatchObject({
      profile: "default",
    })
  }, 10_000)
})

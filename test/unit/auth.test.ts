import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerAuth, SpinboxAuthProvider } from "../../src/auth"
import { ProcessSpinCli } from "../../src/cli/client"
import { configureErrors, TEXT } from "../../src/errors"
import { FAKE_SPIN } from "./fake-spin"

const vs = vi.hoisted(() => {
  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = []
    event = (fn: (e: T) => void) => {
      this.listeners.push(fn)
      return { dispose: () => {} }
    }
    fire(e: T): void {
      for (const fn of this.listeners) {
        fn(e)
      }
    }
    dispose(): void {}
  }
  class CancellationError extends Error {}
  return {
    EventEmitter,
    CancellationError,
    cancel: undefined as (() => void) | undefined,
    report: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    openExternal: vi.fn(),
    registerCommand: vi.fn(),
    registerAuthenticationProvider: vi.fn(),
  }
})

vi.mock("vscode", () => ({
  window: {
    withProgress: (
      _o: unknown,
      task: (p: unknown, t: unknown) => Promise<unknown>,
    ): Promise<unknown> =>
      task(
        { report: vs.report },
        {
          onCancellationRequested: (fn: () => void) => {
            vs.cancel = fn
          },
        },
      ),
    showInformationMessage: vs.showInformationMessage,
    showErrorMessage: vs.showErrorMessage,
  },
  env: { openExternal: vs.openExternal },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  ProgressLocation: { Notification: 15 },
  EventEmitter: vs.EventEmitter,
  CancellationError: vs.CancellationError,
  commands: { registerCommand: vs.registerCommand },
  authentication: { registerAuthenticationProvider: vs.registerAuthenticationProvider },
}))

function provider(): SpinboxAuthProvider {
  return new SpinboxAuthProvider(
    new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} }),
  )
}

function scenario(answers: Record<string, unknown>): void {
  const file = join(mkdtempSync(join(tmpdir(), "spinbox-auth-")), "scenario.json")
  writeFileSync(file, JSON.stringify(answers))
  vi.stubEnv("FAKE_SPIN_SCENARIO", file)
}

// Every spin the provider ran, by its arguments.
function ranLog(): () => string[][] {
  const file = join(mkdtempSync(join(tmpdir(), "spinbox-auth-")), "log")
  writeFileSync(file, "")
  vi.stubEnv("FAKE_SPIN_LOG", file)
  return () =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[])
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vs.cancel = undefined
  configureErrors(undefined)
})

describe("SpinboxAuthProvider sign-in", () => {
  it("opens the page and shows the code from the first line, before the login completes", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "60000")
    const opened = new Promise<void>((resolve) => vs.openExternal.mockImplementation(resolve))
    let settled = false
    const p = provider()
    const signing = p.signIn().finally(() => {
      settled = true
    })
    await opened
    expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(
      "https://app.spinbox.test/device?code=ABCD-EFGH",
    )
    expect(vs.report).toHaveBeenCalledWith({
      message: "enter ABCD-EFGH on the page that opened",
    })
    expect(settled).toBe(false)
    vs.cancel?.()
    await expect(signing).resolves.toBeUndefined()
  })

  // spin waits a minute for its second line: the sign-in ends at once only if cancelling killed
  // it, since a command ends when its process does.
  it("cancelled, kills spin, shows nothing, and createSession rejects as cancelled", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "60000")
    vs.openExternal.mockImplementation(() => vs.cancel?.())
    const p = provider()
    const changes = vi.fn()
    p.onDidChangeSessions(changes)
    const started = Date.now()
    await expect(p.createSession()).rejects.toBeInstanceOf(vs.CancellationError)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(changes).not.toHaveBeenCalled()
    expect(vs.showErrorMessage).not.toHaveBeenCalled()
    expect(vs.showInformationMessage).not.toHaveBeenCalled()
  }, 15_000)

  it("completed, answers a session named for the account's email, and says it was added", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "200")
    const ran = ranLog()
    const p = provider()
    const changes = vi.fn()
    p.onDidChangeSessions(changes)
    const s = await p.createSession()
    expect(s.account).toEqual({ id: "u-1", label: "dev@example.com" })
    expect(s.accessToken).toBe("")
    expect(changes).toHaveBeenCalledWith({ added: [s], removed: [], changed: [] })
    expect(vs.showInformationMessage).toHaveBeenCalledWith(
      "Signed in to Spinbox as dev@example.com.",
    )
    expect(ran()).toEqual([["login", "--no-browser", "-o", "json"]])
  })

  it("failed, shows the CLI's error with its action and answers no session", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "unreachable")
    vs.showErrorMessage.mockResolvedValue(undefined)
    await expect(provider().signIn()).resolves.toBeUndefined()
    expect(vs.showErrorMessage).toHaveBeenCalledWith(TEXT.unreachable, "Retry")
  })

  it("failed, Retry signs in again and answers its session", async () => {
    const ran = ranLog()
    scenario({ login: { error: "unreachable" } })
    vs.showErrorMessage.mockImplementationOnce(async () => {
      vi.stubEnv("FAKE_SPIN_SCENARIO", "")
      return "Retry"
    })
    const s = await provider().signIn()
    expect(s?.account.label).toBe("dev@example.com")
    expect(ran()).toHaveLength(2)
  })
})

describe("SpinboxAuthProvider sessions", () => {
  it("answers the CLI's login as a session named for its email", async () => {
    const ran = ranLog()
    const sessions = await provider().getSessions()
    expect(sessions.map((s) => s.account)).toEqual([{ id: "u-1", label: "dev@example.com" }])
    expect(ran()).toEqual([["version", "-o", "json"]])
  })

  it("answers none when the CLI has no login", async () => {
    scenario({
      version: {
        stdout: [
          { cli: "v1", profile: "default", endpoint: "https://app.spinbox.test", signed_in: false },
        ],
      },
    })
    await expect(provider().getSessions()).resolves.toEqual([])
  })
})

describe("SpinboxAuthProvider sign-out", () => {
  it("runs spin logout and says the session was removed", async () => {
    const ran = ranLog()
    const p = provider()
    const [s] = await p.getSessions()
    const changes = vi.fn()
    p.onDidChangeSessions(changes)
    await p.removeSession()
    expect(ran().at(-1)).toEqual(["logout", "-o", "json"])
    expect(changes).toHaveBeenCalledWith({ added: [], removed: [s], changed: [] })
  })

  it("failed, shows the CLI's error with its action and answers still signed in", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "unreachable")
    vs.showErrorMessage.mockResolvedValue(undefined)
    const p = provider()
    const changes = vi.fn()
    p.onDidChangeSessions(changes)
    await expect(p.signOut()).resolves.toBe(false)
    expect(vs.showErrorMessage).toHaveBeenCalledWith(TEXT.unreachable, "Retry")
    expect(changes).not.toHaveBeenCalled()
  })
})

describe("registerAuth", () => {
  function registered(): Map<string, (...args: unknown[]) => Promise<unknown>> {
    const context = { subscriptions: [] as unknown[] }
    registerAuth(
      context as never,
      new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} }),
    )
    return new Map(vs.registerCommand.mock.calls.map(([id, fn]) => [id, fn]))
  }

  it("registers the provider as spinbox, which package.json contributes", () => {
    registered()
    expect(vs.registerAuthenticationProvider).toHaveBeenCalledWith(
      "spinbox",
      "Spinbox",
      expect.any(SpinboxAuthProvider),
    )
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    )
    expect(manifest.contributes.authentication).toEqual([{ id: "spinbox", label: "Spinbox" }])
    expect(manifest.activationEvents).toContain("onAuthenticationRequest:spinbox")
  })

  it("spinbox.signIn signs in through the provider and answers signed in", async () => {
    await expect(registered().get("spinbox.signIn")?.()).resolves.toBe(true)
    expect(vs.showInformationMessage).toHaveBeenCalledWith(
      "Signed in to Spinbox as dev@example.com.",
    )
  })

  it("spinbox.signOut runs spin logout and answers signed out", async () => {
    const ran = ranLog()
    await expect(registered().get("spinbox.signOut")?.()).resolves.toBe(true)
    expect(ran()).toEqual([["logout", "-o", "json"]])
  })
})

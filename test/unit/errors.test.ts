import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CliError } from "../../src/cli/client"
import type { ErrorCode, ErrorEnvelope } from "../../src/cli/contract"
import { ACTION_OF, ERROR_CODES } from "../../src/cli/contract"
import {
  BUTTON,
  configureErrors,
  KEYRING_SIGNED,
  keyToAdd,
  type Retry,
  showCliError,
  TEXT,
} from "../../src/errors"

const vs = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  withProgress: vi.fn(async (_o: unknown, task: () => Promise<unknown>) => task()),
  executeCommand: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
  createTerminal: vi.fn(),
  onDidCloseTerminal: vi.fn(),
}))

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vs.showErrorMessage,
    showWarningMessage: vs.showWarningMessage,
    showInformationMessage: vs.showInformationMessage,
    withProgress: vs.withProgress,
    createTerminal: vs.createTerminal,
    onDidCloseTerminal: vs.onDidCloseTerminal,
  },
  commands: { executeCommand: vs.executeCommand },
  env: { openExternal: vs.openExternal, clipboard: { writeText: vs.writeText } },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  ProgressLocation: { Notification: 15 },
  version: "1.120.0",
}))

const cli = { run: vi.fn(), version: vi.fn() }
const output = { appendLine: vi.fn(), show: vi.fn() }

function cliError(code: ErrorCode, extra: Partial<ErrorEnvelope["error"]> = {}): CliError {
  return new CliError({
    error: { code, action: ACTION_OF[code], message: `${code} msg`, ...extra },
  })
}

// The one notification shown: its text and buttons, whichever of error or warning it was.
function shown(): { text: string; buttons: string[] } {
  const calls = [...vs.showErrorMessage.mock.calls, ...vs.showWarningMessage.mock.calls]
  expect(calls).toHaveLength(1)
  const [text, ...buttons] = calls[0] as [string, ...string[]]
  return { text, buttons }
}

function click(button: string | undefined): void {
  vs.showErrorMessage.mockResolvedValueOnce(button)
  vs.showWarningMessage.mockResolvedValueOnce(button)
}

const SPIN = "/opt/spin/bin/spin"

// A terminal the extension opens ends, once it is shown, with the exit code this says.
let exitCode: number | undefined

// A home whose ~/.ssh holds each of names, with nothing else in it.
function home(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spinbox-home-"))
  for (const name of names) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), "ssh-ed25519 AAAA test\n")
  }
  vi.stubEnv("HOME", dir)
  return dir
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vs.withProgress.mockImplementation(async (_o, task) => task())
  cli.version.mockResolvedValue({ cli: "v20261105.01", installation: "v20261104.01" })
  exitCode = 0
  const terminal = { show: vi.fn(), sendText: vi.fn(), exitStatus: undefined as unknown }
  vs.createTerminal.mockReturnValue(terminal)
  vs.onDidCloseTerminal.mockImplementation((listener: (t: unknown) => void) => {
    terminal.exitStatus = { code: exitCode }
    queueMicrotask(() => listener(terminal))
    return { dispose: vi.fn() }
  })
  configureErrors({ cli, output, binary: () => Promise.resolve(SPIN), extensionVersion: "0.0.1" })
})

interface Case {
  code: ErrorCode
  extra?: Partial<ErrorEnvelope["error"]>
  text: string
  button: string
  // Arranged before the error is shown.
  setup?: () => void
  // What choosing the button must have done.
  did: (retry: Retry) => void
}

const URL = "https://app.spinbox.test/w/ws-1"
const SIGN_URL = "https://term.spinbox.test/#/sign"

const CASES: Case[] = [
  {
    // The update itself is the action; its failure is what the person sees.
    code: "cli_outdated",
    setup: () => cli.run.mockRejectedValue(new Error("no route")),
    text: `${TEXT.cli_outdated} Updating it failed: no route`,
    button: BUTTON.details,
    did: () => expect(output.show).toHaveBeenCalled(),
  },
  {
    code: "not_signed_in",
    setup: () => vs.executeCommand.mockResolvedValue(true),
    text: TEXT.not_signed_in,
    button: BUTTON.signIn,
    did: (retry) => {
      expect(vs.executeCommand).toHaveBeenCalledWith("spinbox.signIn")
      expect(retry).toHaveBeenCalledWith(undefined)
    },
  },
  {
    code: "workspace_stopped",
    text: TEXT.workspace_stopped,
    button: BUTTON.start,
    did: (retry) => expect(retry).toHaveBeenCalledWith({ start: true }),
  },
  {
    code: "workspace_failed",
    extra: { url: URL, message: "The disk could not be attached." },
    text: `${TEXT.workspace_failed} The disk could not be attached.`,
    button: BUTTON.dashboard,
    did: () => expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(URL),
  },
  {
    code: "access_needs_signature",
    extra: { url: URL },
    text: TEXT.access_needs_signature,
    button: BUTTON.sign,
    did: () => expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(URL),
  },
  {
    // The page opens, and the notification left behind runs the command again.
    code: "keyring_needs_signature",
    extra: { url: SIGN_URL },
    setup: () => vs.showInformationMessage.mockResolvedValueOnce(BUTTON.retry),
    text: TEXT.keyring_needs_signature,
    button: BUTTON.sign,
    did: (retry) => {
      expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(SIGN_URL)
      expect(vs.showInformationMessage).toHaveBeenCalledWith(KEYRING_SIGNED, BUTTON.retry)
      expect(retry).toHaveBeenCalledWith(undefined)
    },
  },
  {
    // spin ssh-key add runs in a terminal with the key spin connects with; it ending well retries.
    code: "no_key_held",
    setup: () => home(".ssh/id_ed25519.pub"),
    text: TEXT.no_key_held,
    button: BUTTON.addKey,
    did: (retry) => {
      expect(vs.createTerminal).toHaveBeenCalledWith({
        name: "Spinbox: Add Key",
        shellPath: SPIN,
        shellArgs: [
          "ssh-key",
          "add",
          hostname(),
          join(process.env.HOME ?? "", ".ssh", "id_ed25519.pub"),
        ],
      })
      expect(retry).toHaveBeenCalledWith(undefined)
    },
  },
  {
    code: "no_capacity",
    text: TEXT.no_capacity,
    button: BUTTON.retry,
    did: (retry) => expect(retry).toHaveBeenCalledWith(undefined),
  },
  {
    code: "unreachable",
    text: TEXT.unreachable,
    button: BUTTON.retry,
    did: (retry) => expect(retry).toHaveBeenCalledWith(undefined),
  },
  {
    // What resolves it is the CLI's message, shown whole.
    code: "no_vscode_server",
    text: `${TEXT.no_vscode_server} no_vscode_server msg`,
    button: BUTTON.details,
    did: () => expect(output.show).toHaveBeenCalled(),
  },
  {
    code: "internal",
    text: `${TEXT.internal} internal msg`,
    button: BUTTON.details,
    did: () => expect(output.show).toHaveBeenCalled(),
  },
]

describe("showCliError", () => {
  it("has one case per code of the contract", () => {
    expect(CASES.map((c) => c.code).sort()).toEqual([...ERROR_CODES].sort())
  })

  it.each(CASES)("$code: shows its text and its button does its action", async (c) => {
    const retry = vi.fn<Retry>().mockResolvedValue(undefined)
    c.setup?.()
    click(c.button)
    await showCliError(cliError(c.code, c.extra), retry)
    expect(shown().text).toBe(c.text)
    expect(shown().buttons).toContain(c.button)
    c.did(retry)
  })

  it.each(CASES)("$code: dismissed, does nothing", async (c) => {
    const retry = vi.fn<Retry>()
    c.setup?.()
    click(undefined)
    await showCliError(cliError(c.code, c.extra), retry)
    expect(retry).not.toHaveBeenCalled()
    expect(vs.executeCommand).not.toHaveBeenCalled()
    expect(vs.openExternal).not.toHaveBeenCalled()
    expect(vs.createTerminal).not.toHaveBeenCalled()
    expect(output.show).not.toHaveBeenCalled()
  })

  it("keyring_needs_signature: the page opened and Retry not chosen, runs nothing again", async () => {
    const retry = vi.fn<Retry>()
    click(BUTTON.sign)
    await showCliError(cliError("keyring_needs_signature", { url: SIGN_URL }), retry)
    expect(vs.openExternal).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
  })

  it("keyring_needs_signature: without a url, offers no page to open", async () => {
    await showCliError(cliError("keyring_needs_signature"), vi.fn<Retry>())
    expect(shown().buttons).toEqual([])
  })

  it("no_key_held: a terminal that did not end well runs nothing again", async () => {
    const retry = vi.fn<Retry>()
    home(".ssh/id_ed25519.pub")
    exitCode = 1
    click(BUTTON.addKey)
    await showCliError(cliError("no_key_held"), retry)
    expect(vs.createTerminal).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
  })

  it("no_key_held: with no key, the terminal has the command that makes one and adds it, not run", async () => {
    const dir = home()
    click(BUTTON.addKey)
    await showCliError(cliError("no_key_held"), vi.fn<Retry>())
    expect(vs.createTerminal).toHaveBeenCalledWith({ name: "Spinbox: Add Key" })
    const made = join(dir, ".ssh", "id_ed25519")
    const terminal = vs.createTerminal.mock.results[0]?.value as {
      sendText: ReturnType<typeof vi.fn>
    }
    expect(terminal.sendText).toHaveBeenCalledWith(
      `ssh-keygen -t ed25519 -f "${made}" && "${SPIN}" ssh-key add "${hostname()}" "${made}.pub"`,
      false,
    )
  })

  it("the key added is the one spin connects with: ~/.ssh's usual ones in order, then spin's own", () => {
    expect(keyToAdd(home())).toBeUndefined()
    const spins = home(".spin/ssh/id_ed25519.pub", ".ssh/id_other.pub")
    expect(keyToAdd(spins)).toBe(join(spins, ".spin", "ssh", "id_ed25519.pub"))
    const ecdsa = home(".spin/ssh/id_ed25519.pub", ".ssh/id_ecdsa.pub")
    expect(keyToAdd(ecdsa)).toBe(join(ecdsa, ".ssh", "id_ecdsa.pub"))
    const rsa = home(".ssh/id_ecdsa.pub", ".ssh/id_rsa.pub")
    expect(keyToAdd(rsa)).toBe(join(rsa, ".ssh", "id_rsa.pub"))
    const ed = home(".ssh/id_rsa.pub", ".ssh/id_ed25519.pub")
    expect(keyToAdd(ed)).toBe(join(ed, ".ssh", "id_ed25519.pub"))
  })

  it("cli_outdated: runs spin update and retries, showing nothing", async () => {
    const retry = vi.fn<Retry>().mockResolvedValue(undefined)
    cli.run.mockResolvedValue({})
    await showCliError(cliError("cli_outdated"), retry)
    expect(cli.run).toHaveBeenCalledWith(["update"])
    expect(retry).toHaveBeenCalledOnce()
    expect(vs.showErrorMessage).not.toHaveBeenCalled()
  })

  it("cli_outdated: a failed update shows why, with Show Details", async () => {
    const retry = vi.fn<Retry>()
    cli.run.mockRejectedValue(cliError("unreachable", { message: "no route" }))
    click(BUTTON.details)
    await showCliError(cliError("cli_outdated"), retry)
    expect(retry).not.toHaveBeenCalled()
    expect(shown()).toEqual({
      text: `${TEXT.cli_outdated} Updating it failed: no route`,
      buttons: [BUTTON.details],
    })
    expect(output.show).toHaveBeenCalled()
  })

  it("cli_outdated: still outdated after the update, it stops and shows details", async () => {
    const retry = vi.fn<Retry>().mockRejectedValueOnce(cliError("cli_outdated"))
    cli.run.mockResolvedValue({})
    await showCliError(cliError("cli_outdated"), retry)
    expect(cli.run).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledOnce()
    expect(shown().buttons).toEqual([BUTTON.details])
  })

  it("not_signed_in: a sign-in that did not complete runs nothing again", async () => {
    const retry = vi.fn<Retry>()
    vs.executeCommand.mockResolvedValue(false)
    click(BUTTON.signIn)
    await showCliError(cliError("not_signed_in"), retry)
    expect(vs.executeCommand).toHaveBeenCalledWith("spinbox.signIn")
    expect(retry).not.toHaveBeenCalled()
  })

  it("internal: Copy Diagnostics copies the code, the message and the versions", async () => {
    click(BUTTON.copy)
    await showCliError(cliError("internal"))
    expect(shown().buttons).toEqual([BUTTON.details, BUTTON.copy])
    const copied = String(vs.writeText.mock.calls[0]?.[0])
    for (const s of [
      "internal",
      "internal msg",
      "0.0.1",
      "1.120.0",
      "v20261105.01",
      "v20261104.01",
    ]) {
      expect(copied).toContain(s)
    }
  })

  it("an error that is not a CliError is shown as internal", async () => {
    click(undefined)
    await showCliError(new Error("boom"))
    expect(shown()).toEqual({
      text: `${TEXT.internal} boom`,
      buttons: [BUTTON.details, BUTTON.copy],
    })
  })

  it("a retry that fails again is shown by its own code", async () => {
    const retry = vi.fn<Retry>().mockRejectedValueOnce(cliError("not_signed_in"))
    vs.showErrorMessage.mockResolvedValueOnce(BUTTON.retry)
    await showCliError(cliError("unreachable"), retry)
    expect(vs.showWarningMessage).toHaveBeenCalledWith(TEXT.not_signed_in, BUTTON.signIn)
  })

  it("without a retry or a url, a code shows no button it cannot honour", async () => {
    await showCliError(cliError("no_capacity"))
    expect(shown().buttons).toEqual([])
  })

  it("logs every error to the Spinbox channel", async () => {
    await showCliError(cliError("unreachable"))
    expect(output.appendLine).toHaveBeenCalledWith("[unreachable] unreachable msg")
  })
})

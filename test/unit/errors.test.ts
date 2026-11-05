import { beforeEach, describe, expect, it, vi } from "vitest"
import { CliError } from "../../src/cli/client"
import type { ErrorCode, ErrorEnvelope } from "../../src/cli/contract"
import { ACTION_OF, ERROR_CODES } from "../../src/cli/contract"
import { BUTTON, configureErrors, type Retry, showCliError, TEXT } from "../../src/errors"

const vs = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn(async (_o: unknown, task: () => Promise<unknown>) => task()),
  executeCommand: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vs.showErrorMessage,
    showWarningMessage: vs.showWarningMessage,
    withProgress: vs.withProgress,
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

beforeEach(() => {
  vi.resetAllMocks()
  vs.withProgress.mockImplementation(async (_o, task) => task())
  cli.version.mockResolvedValue({ cli: "v20261105.01", installation: "v20261104.01" })
  configureErrors({ cli, output, extensionVersion: "0.0.1" })
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
    text: TEXT.not_signed_in,
    button: BUTTON.signIn,
    did: () => expect(vs.executeCommand).toHaveBeenCalledWith("spinbox.signIn"),
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
    expect(output.show).not.toHaveBeenCalled()
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

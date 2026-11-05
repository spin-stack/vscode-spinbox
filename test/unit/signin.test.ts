import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProcessSpinCli } from "../../src/cli/client"
import { configureErrors, TEXT } from "../../src/errors"
import { signIn } from "../../src/signin"
import { FAKE_SPIN } from "./fake-spin"

const vs = vi.hoisted(() => ({
  cancel: undefined as (() => void) | undefined,
  report: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  openExternal: vi.fn(),
}))

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
}))

function cli(): ProcessSpinCli {
  return new ProcessSpinCli({ binary: () => Promise.resolve(FAKE_SPIN), log: () => {} })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vs.cancel = undefined
  configureErrors(undefined)
})

describe("signIn", () => {
  it("opens the page, shows the code, and answers signed in", async () => {
    await expect(signIn(cli())).resolves.toBe(true)
    expect(String(vs.openExternal.mock.calls[0]?.[0])).toBe(
      "https://app.spinbox.test/device?code=ABCD-EFGH",
    )
    expect(vs.report).toHaveBeenCalledWith({
      message: "enter ABCD-EFGH on the page that opened",
    })
    expect(vs.showInformationMessage).toHaveBeenCalledWith(
      "Signed in to Spinbox as dev@example.com.",
    )
  })

  it("cancelled, shows nothing and answers not signed in", async () => {
    vi.stubEnv("FAKE_SPIN_LOGIN_DELAY_MS", "60000")
    vs.openExternal.mockImplementation(() => vs.cancel?.())
    await expect(signIn(cli())).resolves.toBe(false)
    expect(vs.showErrorMessage).not.toHaveBeenCalled()
    expect(vs.showInformationMessage).not.toHaveBeenCalled()
  })

  it("failed, shows the CLI's error and answers not signed in", async () => {
    vi.stubEnv("FAKE_SPIN_ERROR", "unreachable")
    vs.showErrorMessage.mockResolvedValue(undefined)
    await expect(signIn(cli())).resolves.toBe(false)
    expect(vs.showErrorMessage).toHaveBeenCalledWith(TEXT.unreachable, "Retry")
  })
})

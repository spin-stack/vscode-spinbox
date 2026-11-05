import * as vscode from "vscode"
import { CliError, type SpinCli } from "../cli/client"
import type { ErrorCode, ErrorEnvelope } from "../cli/contract"

// What showCliError needs from the rest of the extension: the CLI it updates and asks its version,
// the Spinbox output channel that 'Show Details' opens, and the extension's own version for a
// diagnostic. Set once at activation by configureErrors.
export interface ErrorDeps {
  cli: Pick<SpinCli, "run" | "version">
  output: Pick<vscode.OutputChannel, "appendLine" | "show">
  extensionVersion: string
}

let deps: ErrorDeps | undefined

export function configureErrors(d: ErrorDeps | undefined): void {
  deps = d
}

// A retry is the command that failed, run again. workspace_stopped's runs it with start set, which
// a `spin code` retry passes on as --start.
export interface RetryOptions {
  start?: boolean
}

export type Retry = (opts?: RetryOptions) => Promise<void>

export const BUTTON = {
  details: "Show Details",
  copy: "Copy Diagnostics",
  signIn: "Sign In",
  start: "Start",
  dashboard: "Open in Dashboard",
  sign: "Sign in Browser",
  retry: "Retry",
} as const

// Shows error as a notification with the action its code pairs with, and does that action when
// its button is chosen. Resolves once the notification is answered and its action has run. An
// error that is not a CliError is shown as internal.
export async function showCliError(error: unknown, retry?: Retry): Promise<void> {
  await show(envelopeOf(error), retry, false)
}

function envelopeOf(error: unknown): ErrorEnvelope {
  if (error instanceof CliError) {
    return error.envelope
  }
  const message = error instanceof Error ? error.message : String(error)
  return { error: { code: "internal", action: "details", message } }
}

async function show(env: ErrorEnvelope, retry: Retry | undefined, updated: boolean): Promise<void> {
  const e = env.error
  deps?.output.appendLine(`[${e.code}] ${e.message}`)
  const again = (opts?: RetryOptions) => runRetry(retry, opts, updated)
  switch (e.code) {
    case "cli_outdated":
      return updated ? details(`${TEXT.cli_outdated} The update did not take.`) : update(retry)
    case "not_signed_in":
      // spinbox.signIn answers whether the person signed in; only then is the command run again.
      if (
        (await vscode.window.showWarningMessage(TEXT.not_signed_in, BUTTON.signIn)) !== undefined &&
        (await vscode.commands.executeCommand<boolean>("spinbox.signIn")) === true
      ) {
        await again()
      }
      return
    case "workspace_stopped":
      return offer(
        vscode.window.showWarningMessage,
        TEXT.workspace_stopped,
        BUTTON.start,
        retry,
        () => again({ start: true }),
      )
    case "workspace_failed":
      return offerUrl(withReason(TEXT.workspace_failed, e.message), BUTTON.dashboard, e.url)
    case "access_needs_signature":
      return offerUrl(TEXT.access_needs_signature, BUTTON.sign, e.url)
    case "no_capacity":
    case "unreachable":
      return offer(vscode.window.showErrorMessage, TEXT[e.code], BUTTON.retry, retry, () => again())
    case "internal":
      return internal(e)
  }
}

// What each code tells the person: what happened and what to do.
export const TEXT = {
  cli_outdated: "The spin CLI is too old for this installation.",
  not_signed_in: "You are signed out of Spinbox. Sign in to continue.",
  workspace_stopped: "This workspace is stopped. Start it to open it.",
  workspace_failed: "This workspace failed. Open it in the dashboard to see why.",
  access_needs_signature:
    "This workspace needs your signature. Sign in the browser, then try again.",
  no_capacity: "No host has room for this workspace right now. Try again in a moment.",
  unreachable: "Spinbox cannot reach the installation. Check your connection and try again.",
  internal: "Spinbox hit an unexpected error.",
} as const satisfies Record<ErrorCode, string>

function withReason(text: string, reason: string): string {
  return reason === "" ? text : `${text} ${reason}`
}

type Show = (message: string, ...items: string[]) => Thenable<string | undefined>

async function offer(
  showMessage: Show,
  text: string,
  button: string,
  retry: Retry | undefined,
  act: () => Promise<void>,
): Promise<void> {
  const buttons = retry === undefined ? [] : [button]
  if ((await showMessage(text, ...buttons)) === button) {
    await act()
  }
}

async function offerUrl(text: string, button: string, url: string | undefined): Promise<void> {
  const buttons = url === undefined ? [] : [button]
  if ((await vscode.window.showErrorMessage(text, ...buttons)) === button && url !== undefined) {
    await vscode.env.openExternal(vscode.Uri.parse(url))
  }
}

// cli_outdated: the extension updates the CLI itself and runs the command again; only a failed
// update is shown, with its detail.
async function update(retry: Retry | undefined): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Updating the spin CLI…" },
      async () => {
        if (deps === undefined) {
          throw new Error("the extension has no spin CLI to update")
        }
        await deps.cli.run(["update"])
      },
    )
  } catch (err) {
    const reason = envelopeOf(err).error.message
    deps?.output.appendLine(`spin update failed: ${reason}`)
    return details(`${TEXT.cli_outdated} Updating it failed: ${reason}`)
  }
  await runRetry(retry, undefined, true)
}

async function runRetry(
  retry: Retry | undefined,
  opts: RetryOptions | undefined,
  updated: boolean,
): Promise<void> {
  if (retry === undefined) {
    return
  }
  try {
    await retry(opts)
  } catch (err) {
    await show(envelopeOf(err), retry, updated)
  }
}

async function details(text: string): Promise<void> {
  if ((await vscode.window.showErrorMessage(text, BUTTON.details)) === BUTTON.details) {
    deps?.output.show(true)
  }
}

async function internal(e: ErrorEnvelope["error"]): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    withReason(TEXT.internal, e.message),
    BUTTON.details,
    BUTTON.copy,
  )
  if (choice === BUTTON.details) {
    deps?.output.show(true)
  } else if (choice === BUTTON.copy) {
    await vscode.env.clipboard.writeText(await diagnostic(e))
  }
}

// The code, the message, and every version that tells which builds met: the extension's, VS
// Code's, the CLI's, and the installation's.
async function diagnostic(e: ErrorEnvelope["error"]): Promise<string> {
  let cli = "unknown"
  let installation = e.release ?? "unknown"
  try {
    const v = await deps?.cli.version()
    if (v !== undefined) {
      cli = v.cli
      installation = v.installation ?? installation
    }
  } catch {
    // The diagnostic is still worth copying without the CLI's version.
  }
  return [
    `code: ${e.code}`,
    `message: ${e.message}`,
    `extension: ${deps?.extensionVersion ?? "unknown"}`,
    `vscode: ${vscode.version}`,
    `cli: ${cli}`,
    `installation: ${installation}`,
  ].join("\n")
}

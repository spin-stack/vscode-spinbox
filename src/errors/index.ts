import { existsSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import * as vscode from "vscode"
import { CliError, type SpinCli } from "../cli/client"
import type { ErrorCode, ErrorEnvelope } from "../cli/contract"
import { traceIdOf } from "../telemetry"

// What showCliError needs from the rest of the extension: the CLI it updates and asks its version,
// the Spinbox output channel that 'Show Details' opens, the path of spin for 'Add Key' to run in a
// terminal, and the extension's own version for a diagnostic. Set once at activation by
// configureErrors.
export interface ErrorDeps {
  cli: Pick<SpinCli, "run" | "version">
  output: Pick<vscode.OutputChannel, "appendLine" | "show">
  binary: () => Promise<string>
  extensionVersion: string
}

let deps: ErrorDeps | undefined

export function configureErrors(d: ErrorDeps | undefined): void {
  deps = d
}

// A retry is the command that failed, run again. workspace_stopped's runs it with start set, which
// a `spin code` retry passes on as --start. It rejects with the failure of that run, which is shown
// in its place: a retry that showed its failure itself would show a cli_outdated surviving the
// update as a new one, and update again without end.
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
  addKey: "Add Key",
  retry: "Retry",
} as const

// Shows error as a notification with the action its code pairs with, and does that action when
// its button is chosen. Resolves once the notification is answered and its action has run. An
// error that is not a CliError is shown as internal.
export async function showCliError(error: unknown, retry?: Retry): Promise<void> {
  await show(error, retry, false)
}

function envelopeOf(error: unknown): ErrorEnvelope {
  if (error instanceof CliError) {
    return error.envelope
  }
  const message = error instanceof Error ? error.message : String(error)
  return { error: { code: "internal", action: "details", message } }
}

// The trace-id of the command that failed, when it ran in a trace.
function traceIdOfError(error: unknown): string | undefined {
  return error instanceof CliError ? traceIdOf(error.traceparent) : undefined
}

async function show(error: unknown, retry: Retry | undefined, updated: boolean): Promise<void> {
  const e = envelopeOf(error).error
  const traceId = traceIdOfError(error)
  deps?.output.appendLine(
    `[${e.code}] ${e.message}${traceId === undefined ? "" : ` (trace ${traceId})`}`,
  )
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
    case "key_not_enrolled":
      // A key is worth adding with nothing to run again: the next command finds it.
      if (
        (await vscode.window.showErrorMessage(TEXT.key_not_enrolled, BUTTON.addKey)) ===
        BUTTON.addKey
      ) {
        try {
          await addKey(() => again())
        } catch (err) {
          // A spin that cannot be found to run in the terminal.
          await show(err, undefined, updated)
        }
      }
      return
    case "no_capacity":
    case "unreachable":
      return offer(vscode.window.showErrorMessage, TEXT[e.code], BUTTON.retry, retry, () => again())
    case "no_extension_release":
      return internal(e, traceId, TEXT.no_extension_release)
    case "no_vscode_server":
      // The message is what was refused and what resolves it - an administrator's publish, or
      // more room - so it is shown whole, with what internal offers beside it.
      return internal(e, traceId, TEXT.no_vscode_server)
    case "internal":
      return internal(e, traceId)
  }
}

// What each code tells the person: what happened and what to do.
export const TEXT = {
  cli_outdated: "The spin CLI is too old for this installation.",
  not_signed_in: "You are signed out of Spinbox. Sign in to continue.",
  workspace_stopped: "This workspace is stopped. Start it to open it.",
  workspace_failed: "This workspace failed. Open it in the dashboard to see why.",
  key_not_enrolled:
    "The key this machine connects with is not on your account. Add it, with your passkey, to connect.",
  no_capacity: "No host has room for this workspace right now. Try again in a moment.",
  unreachable: "Spinbox cannot reach the installation. Check your connection and try again.",
  no_extension_release: "No release of the Spinbox extension carries this spin CLI's release.",
  no_vscode_server: "This workspace has no server for your VS Code, and no room to download one.",
  internal: "Spinbox hit an unexpected error.",
} as const satisfies Record<ErrorCode, string>

// The public key spin connects with where the account has none of this machine's: the first of
// the usual ones in ~/.ssh, or spin's own (cmd/cli/cmd/ssh.go, usualIdentity). Undefined when this
// machine has none of them.
export function keyToAdd(home: string): string | undefined {
  return [
    join(home, ".ssh", "id_ed25519.pub"),
    join(home, ".ssh", "id_rsa.pub"),
    join(home, ".ssh", "id_ecdsa.pub"),
    join(home, ".spin", "ssh", "id_ed25519.pub"),
  ].find((p) => existsSync(p))
}

// key_not_enrolled: `spin ssh-key add` in a terminal, named for this machine, with the key spin
// connects with. It opens the page where the person's passkey confirms the key, and waits - which
// only a person can finish, so it is run there and not by the extension. With
// no key to add, the terminal has the command that makes one and adds it, ready to run. The
// command runs again once the terminal ends with exit 0.
async function addKey(again: () => Promise<void>): Promise<void> {
  if (deps === undefined) {
    return
  }
  const spin = await deps.binary()
  const key = keyToAdd(homedir())
  const name = "Spinbox: Add Key"
  let terminal: vscode.Terminal
  if (key === undefined) {
    const made = join(homedir(), ".ssh", "id_ed25519")
    terminal = vscode.window.createTerminal({ name })
    terminal.sendText(
      `ssh-keygen -t ed25519 -f ${JSON.stringify(made)} && ${JSON.stringify(spin)} ssh-key add ${JSON.stringify(hostname())} ${JSON.stringify(`${made}.pub`)}`,
      false,
    )
  } else {
    terminal = vscode.window.createTerminal({
      name,
      shellPath: spin,
      shellArgs: ["ssh-key", "add", hostname(), key],
    })
  }
  terminal.show()
  if ((await ended(terminal)) === 0) {
    await again()
  }
}

// The exit code terminal ends with, once it is closed: undefined where the person closed it.
function ended(terminal: vscode.Terminal): Promise<number | undefined> {
  return new Promise((resolve) => {
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        sub.dispose()
        resolve(t.exitStatus?.code)
      }
    })
  })
}

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
    await show(err, retry, updated)
  }
}

async function details(text: string): Promise<void> {
  if ((await vscode.window.showErrorMessage(text, BUTTON.details)) === BUTTON.details) {
    deps?.output.show(true)
  }
}

async function internal(
  e: ErrorEnvelope["error"],
  traceId: string | undefined,
  text: string = TEXT.internal,
): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    withReason(text, e.message),
    BUTTON.details,
    BUTTON.copy,
  )
  if (choice === BUTTON.details) {
    deps?.output.show(true)
  } else if (choice === BUTTON.copy) {
    await vscode.env.clipboard.writeText(await diagnostic(e, traceId))
  }
}

// The code, the message, and every version that tells which builds met: the extension's, VS
// Code's, the CLI's, and the installation's; and the trace-id of the command that failed, which
// Admin -> Traces finds it by.
async function diagnostic(e: ErrorEnvelope["error"], traceId: string | undefined): Promise<string> {
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
    `trace: ${traceId ?? "none"}`,
  ].join("\n")
}

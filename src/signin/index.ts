import * as vscode from "vscode"
import type { SpinCli } from "../cli/client"
import { showCliError } from "../errors"

export type SignInCli = Pick<SpinCli, "login">

// registerSignIn registers spinbox.signIn. The command answers whether the person is signed in
// once it ends, which not_signed_in's Sign In waits for before it runs the failed command again.
export function registerSignIn(context: vscode.ExtensionContext, cli: SignInCli): void {
  context.subscriptions.push(vscode.commands.registerCommand("spinbox.signIn", () => signIn(cli)))
}

// signIn runs `spin login --no-browser` under a cancelable notification that shows the code, and
// opens the page that takes it in the browser. A failure is shown with its action, Retry signing
// in again; cancelling shows nothing.
export async function signIn(cli: SignInCli): Promise<boolean> {
  const abort = new AbortController()
  try {
    const done = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Signing in to Spinbox",
        cancellable: true,
      },
      (progress, token) => {
        token.onCancellationRequested(() => abort.abort())
        return cli.login(
          (start) => {
            progress.report({ message: `enter ${start.user_code} on the page that opened` })
            void vscode.env.openExternal(vscode.Uri.parse(start.verification_url))
          },
          { signal: abort.signal },
        )
      },
    )
    void vscode.window.showInformationMessage(`Signed in to Spinbox as ${done.user.email}.`)
    return true
  } catch (err) {
    if (abort.signal.aborted) {
      return false
    }
    let signedIn = false
    await showCliError(err, async () => {
      signedIn = await signIn(cli)
    })
    return signedIn
  }
}

import * as vscode from "vscode"
import type { SpinCli } from "../cli/client"
import type { LoginDone, User, VersionResult } from "../cli/contract"
import { showCliError } from "../errors"

export const PROVIDER_ID = "spinbox"
export const PROVIDER_LABEL = "Spinbox"

export type AuthCli = Pick<SpinCli, "login" | "version" | "run">

// SpinboxAuthProvider is the 'Spinbox' account in VS Code's Accounts menu. The login is the CLI's:
// spin keeps the token where it keeps it, and a session here carries only who is signed in, with
// an empty accessToken. Whatever needs the installation runs spin, never the token.
export class SpinboxAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changed =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
  readonly onDidChangeSessions = this.changed.event
  // The sessions last answered, which a sign-out reports as removed.
  private known: vscode.AuthenticationSession[] = []

  constructor(private readonly cli: AuthCli) {}

  dispose(): void {
    this.changed.dispose()
  }

  // spin version -o json: one session while the CLI has a login, none without. A failure (the
  // installation unreachable) rejects, for the caller to show.
  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const v = await this.cli.version()
    this.known = v.signed_in ? [session(v, v.user)] : []
    return this.known
  }

  // Signs in, the Accounts menu's way: a cancelled or failed sign-in rejects, a failure after it
  // was shown with its action.
  async createSession(): Promise<vscode.AuthenticationSession> {
    const s = await this.signIn()
    if (s === undefined) {
      throw new vscode.CancellationError()
    }
    return s
  }

  async removeSession(): Promise<void> {
    await this.signOut()
  }

  // signIn runs `spin login --no-browser` under a cancelable notification that shows the code,
  // and opens the page that takes it in the browser. Cancelling kills spin and answers undefined;
  // a failure is shown with its action, whose Retry signs in again.
  async signIn(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await this.login()
    } catch (err) {
      let s: vscode.AuthenticationSession | undefined
      await showCliError(err, async () => {
        s = await this.login()
      })
      return s
    }
  }

  // signOut runs `spin logout`. A failure is shown with its action, whose Retry runs it again.
  // Answers whether the person is signed out.
  async signOut(): Promise<boolean> {
    try {
      await this.logout()
      return true
    } catch (err) {
      let out = false
      await showCliError(err, async () => {
        await this.logout()
        out = true
      })
      return out
    }
  }

  private async login(): Promise<vscode.AuthenticationSession | undefined> {
    const abort = new AbortController()
    let done: LoginDone
    try {
      done = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Signing in to Spinbox",
          cancellable: true,
        },
        (progress, token) => {
          token.onCancellationRequested(() => abort.abort())
          return this.cli.login(
            (start) => {
              progress.report({ message: `enter ${start.user_code} on the page that opened` })
              void vscode.env.openExternal(vscode.Uri.parse(start.verification_url))
            },
            { signal: abort.signal },
          )
        },
      )
    } catch (err) {
      if (abort.signal.aborted) {
        return undefined
      }
      throw err
    }
    const s = session(done, done.user)
    const removed = this.known.filter((k) => k.id !== s.id)
    this.known = [s]
    this.changed.fire({ added: [s], removed, changed: [] })
    void vscode.window.showInformationMessage(`Signed in to Spinbox as ${done.user.email}.`)
    return s
  }

  private async logout(): Promise<void> {
    await this.cli.run(["logout"])
    const removed = this.known
    this.known = []
    this.changed.fire({ added: [], removed, changed: [] })
  }
}

// One session per CLI profile and endpoint, named for the person signed in. A login whose user the
// CLI did not report (it did not reach the installation) is named for the profile.
function session(
  at: Pick<VersionResult, "profile" | "endpoint">,
  user: User | undefined,
): vscode.AuthenticationSession {
  return {
    id: `${at.profile}@${at.endpoint}`,
    accessToken: "",
    account: {
      id: user?.id ?? `${at.profile}@${at.endpoint}`,
      label: user?.email ?? `${at.profile} (${at.endpoint})`,
    },
    scopes: [],
  }
}

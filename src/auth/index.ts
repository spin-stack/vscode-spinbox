import * as vscode from "vscode"
import { type AuthCli, PROVIDER_ID, PROVIDER_LABEL, SpinboxAuthProvider } from "./provider"

export { type AuthCli, PROVIDER_ID, PROVIDER_LABEL, SpinboxAuthProvider } from "./provider"

// registerAuth registers the 'Spinbox' authentication provider and the commands that use it.
// spinbox.signIn answers whether the person is signed in once it ends, which not_signed_in's Sign
// In waits for before it runs the failed command again; spinbox.signOut answers whether they are
// signed out.
export function registerAuth(context: vscode.ExtensionContext, cli: AuthCli): SpinboxAuthProvider {
  const provider = new SpinboxAuthProvider(cli)
  context.subscriptions.push(
    provider,
    vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, PROVIDER_LABEL, provider),
    vscode.commands.registerCommand(
      "spinbox.signIn",
      async () => (await provider.signIn()) !== undefined,
    ),
    vscode.commands.registerCommand("spinbox.signOut", () => provider.signOut()),
  )
  return provider
}

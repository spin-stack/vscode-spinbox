// What spin-stack.open-remote-ssh's activation does first that the proposed API decides: register
// a remote authority resolver. VS Code throws here when the API is withheld.
const vscode = require("vscode")

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.workspace.registerRemoteAuthorityResolver("spin", {
      resolve: () => {
        throw new Error("the stand-in resolves nothing")
      },
    }),
  )
}

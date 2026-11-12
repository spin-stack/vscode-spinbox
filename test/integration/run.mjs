// Starts a VS Code stable, downloaded into .vscode-test/ at the version engines.vscode names, with
// this extension and the stand-in for spin-stack.open-remote-ssh in testdata/resolver/ loaded, and the
// suite dist-test/suite.js run in its extension host: once as VS Code is installed, which withholds
// the proposed API from the stand-in, and once with --enable-proposed-api for it, what argv.json's
// enable-proposed-api line gives. Needs a display: CI runs it under xvfb-run.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runTests } from "@vscode/test-electron"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const { engines } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))

for (const [route, flags] of [
  ["disabled", []],
  ["spin", ["--enable-proposed-api", "spin-stack.open-remote-ssh"]],
]) {
  await runTests({
    version: engines.vscode.replace(/^\^/, ""),
    extensionDevelopmentPath: [root, resolve(root, "test/integration/testdata/resolver")],
    extensionTestsPath: resolve(root, "dist-test/suite.js"),
    extensionTestsEnv: { SPINBOX_WANT_ROUTE: route },
    launchArgs: ["--disable-extensions", "--disable-workspace-trust", ...flags],
  })
}

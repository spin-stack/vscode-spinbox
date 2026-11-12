// Starts VS Code stable, downloaded into .vscode-test/ at the version engines.vscode names, with
// this extension loaded and the suite dist-test/suite.js run in its extension host, three times:
//
//   - alone: the resolver is missing;
//   - with the stand-in for spin-stack.spinbox-remote in testdata/resolver/, as VS Code is
//     installed: it withholds the proposed API, so the resolver is disabled;
//   - the same with --enable-proposed-api for the stand-in, which is what argv.json's
//     enable-proposed-api line gives: the resolver is active.
//
// Needs a display: CI runs it under xvfb-run.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runTests } from "@vscode/test-electron"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const { engines } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const resolver = resolve(root, "test/integration/testdata/resolver")

for (const [route, extensions, flags] of [
  ["missing", [root], []],
  ["disabled", [root, resolver], []],
  ["spin", [root, resolver], ["--enable-proposed-api", "spin-stack.spinbox-remote"]],
]) {
  await runTests({
    version: engines.vscode.replace(/^\^/, ""),
    extensionDevelopmentPath: extensions,
    extensionTestsPath: resolve(root, "dist-test/suite.js"),
    extensionTestsEnv: { SPINBOX_WANT_ROUTE: route },
    launchArgs: ["--disable-extensions", "--disable-workspace-trust", ...flags],
  })
}

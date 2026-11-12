// Starts VS Code stable, downloaded into .vscode-test/, with this extension loaded and the suite
// dist-test/suite.js run in its extension host, three times:
//
//   - at the version engines.vscode names, alone: the resolver is missing;
//   - at VSCODE_GATED (versions.yaml's vscode, set by task test:integration) with the stand-in
//     for spin-stack.open-remote-ssh in testdata/resolver/, as VS Code is installed: it withholds
//     the proposed API, so the resolver is disabled;
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
const gated = process.env.VSCODE_GATED
if (!gated) {
  throw new Error("VSCODE_GATED names no VS Code version: run it as task test:integration")
}
const resolver = resolve(root, "test/integration/testdata/resolver")

for (const [route, version, extensions, flags] of [
  ["missing", engines.vscode.replace(/^\^/, ""), [root], []],
  ["disabled", gated, [root, resolver], []],
  ["spin", gated, [root, resolver], ["--enable-proposed-api", "spin-stack.open-remote-ssh"]],
]) {
  await runTests({
    version,
    extensionDevelopmentPath: extensions,
    extensionTestsPath: resolve(root, "dist-test/suite.js"),
    extensionTestsEnv: { SPINBOX_WANT_ROUTE: route },
    launchArgs: ["--disable-extensions", "--disable-workspace-trust", ...flags],
  })
}

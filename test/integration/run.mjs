// Starts a VS Code, downloaded into .vscode-test/ at the version engines.vscode names, with this
// extension loaded and the suite dist-test/suite.js run in its extension host. Needs a display:
// CI runs it under xvfb-run.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runTests } from "@vscode/test-electron"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const { engines } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))

await runTests({
  version: engines.vscode.replace(/^\^/, ""),
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, "dist-test/suite.js"),
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
})

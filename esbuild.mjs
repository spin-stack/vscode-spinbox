// Bundles the extension into dist/extension.js, or with --tests the integration suite into
// dist-test/, which VS Code loads in its extension host. vscode is VS Code's own, never bundled.
import { build } from "esbuild"

const tests = process.argv.includes("--tests")

await build({
  entryPoints: tests ? ["test/integration/suite.ts"] : ["src/extension.ts"],
  outfile: tests ? "dist-test/suite.js" : "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  minify: !tests,
  logLevel: "warning",
})

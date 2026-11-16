// Bundles the extension into dist/extension.js, or with --tests the integration suite into
// dist-test/, which VS Code loads in its extension host. vscode is VS Code's own, never bundled.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"

const tests = process.argv.includes("--tests")

const result = await build({
  entryPoints: tests ? ["test/integration/suite.ts"] : ["src/extension.ts"],
  outfile: tests ? "dist-test/suite.js" : "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  minify: !tests,
  metafile: !tests,
  logLevel: "warning",
})

if (!tests) {
  writeFileSync("dist/THIRD_PARTY_NOTICES", notices(Object.keys(result.metafile.inputs)))
}

// The license of every package the bundle took code from, as its MIT, BSD or Apache terms demand
// of a copy: the metafile's inputs are exactly what esbuild put in extension.js, so a package
// only installed for building is never named and one that reaches the bundle always is.
function notices(inputs) {
  const dirs = new Set()
  for (const input of inputs) {
    const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)
    if (m) dirs.add(m[1])
  }
  const parts = [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const file = readdirSync(dir)
      .sort()
      .find((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    if (!file) throw new Error(`${pkg.name}@${pkg.version} is bundled and ships no license file`)
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`
  })
  const head = "Third-party software in dist/extension.js and the license of each.\n"
  if (parts.length === 0) return `${head}\nThe bundle includes no third-party package.\n`
  return [head, ...parts].join(`\n${"-".repeat(80)}\n\n`)
}

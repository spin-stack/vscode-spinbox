import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SpinBinary, SpinNotFoundError, targetDir } from "../../src/cli/binary"
import { ProcessSpinCli } from "../../src/cli/client"
import { FAKE_SPIN } from "./fake-spin"

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "spin-binary-"))
  const extensionPath = join(root, "ext")
  const storagePath = join(root, "storage")
  mkdirSync(join(extensionPath, "bin", "linux-x64"), { recursive: true })
  return { extensionPath, storagePath }
}

// Puts a CLI in the VSIX's bin/linux-x64, as the given release.
function carry(extensionPath: string, release: string, content: string) {
  const dir = join(extensionPath, "bin", "linux-x64")
  writeFileSync(join(dir, "spin"), content)
  writeFileSync(join(dir, "VERSION"), `${release}\n`)
}

function binary(extensionPath: string, storagePath: string, cliPath = "") {
  return new SpinBinary({
    extensionPath,
    storagePath,
    cliPath: () => cliPath,
    platform: "linux",
    arch: "x64",
  })
}

describe("SpinBinary", () => {
  it("installs the carried CLI into global storage once, executable", async () => {
    const { extensionPath, storagePath } = dirs()
    carry(extensionPath, "v20261105.01", "first")
    const installed = await binary(extensionPath, storagePath).path()
    expect(installed).toBe(join(storagePath, "bin", "spin"))
    expect(readFileSync(installed, "utf8")).toBe("first")
    expect(statSync(installed).mode & 0o111).toBe(0o111)

    // The same release carried again, as after a reload: what is installed stays.
    carry(extensionPath, "v20261105.01", "second")
    expect(await binary(extensionPath, storagePath).path()).toBe(installed)
    expect(readFileSync(installed, "utf8")).toBe("first")
  })

  it("replaces the installed CLI when the carried release is newer, at the same path", async () => {
    const { extensionPath, storagePath } = dirs()
    carry(extensionPath, "v20261105.01", "old")
    const installed = await binary(extensionPath, storagePath).path()
    carry(extensionPath, "v20261105.02", "new")
    expect(await binary(extensionPath, storagePath).path()).toBe(installed)
    expect(readFileSync(installed, "utf8")).toBe("new")
  })

  it("keeps the installed CLI when the carried release is older", async () => {
    const { extensionPath, storagePath } = dirs()
    carry(extensionPath, "v20261110.01", "newer")
    const installed = await binary(extensionPath, storagePath).path()
    carry(extensionPath, "v20261105.01", "older")
    await binary(extensionPath, storagePath).path()
    expect(readFileSync(installed, "utf8")).toBe("newer")
  })

  it("runs spinbox.cliPath when it names one, and installs nothing", async () => {
    const { extensionPath, storagePath } = dirs()
    carry(extensionPath, "v20261105.01", "carried")
    expect(await binary(extensionPath, storagePath, "/opt/spin").path()).toBe("/opt/spin")
    expect(() => statSync(join(storagePath, "bin", "spin"))).toThrow()
  })

  it("fails with SpinNotFoundError when the VSIX carries no CLI for the platform", async () => {
    const { extensionPath, storagePath } = dirs()
    const b = new SpinBinary({
      extensionPath,
      storagePath,
      cliPath: () => "",
      platform: "win32",
      arch: "x64",
    })
    await expect(b.path()).rejects.toBeInstanceOf(SpinNotFoundError)
    await expect(binary(extensionPath, storagePath).path()).rejects.toBeInstanceOf(
      SpinNotFoundError,
    )
  })

  it("installs a CLI that runs", async () => {
    const { extensionPath, storagePath } = dirs()
    carry(extensionPath, "v20261105.01", readFileSync(FAKE_SPIN, "utf8"))
    const b = binary(extensionPath, storagePath)
    const cli = new ProcessSpinCli({ binary: () => b.path(), log: () => {} })
    await expect(cli.version()).resolves.toMatchObject({ cli: "v20261105.01" })
  })

  // What package:all builds: hack/spinbin names each target's directory, and .vscodeignore lets
  // the two files the install reads into the VSIX.
  it("looks where package:all puts the CLI", () => {
    const spinbin = readFileSync(new URL("../../hack/spinbin/main.go", import.meta.url), "utf8")
    const targets = [...spinbin.matchAll(/\{"[a-z0-9-]+", "([a-z0-9-]+)"\}/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      const [platform, arch] = (target ?? "").split("-") as [NodeJS.Platform, NodeJS.Architecture]
      expect(targetDir(platform, arch)).toBe(target)
    }
    const ignore = readFileSync(new URL("../../.vscodeignore", import.meta.url), "utf8").split("\n")
    expect(ignore).toEqual(expect.arrayContaining(["!bin/*/spin", "!bin/*/VERSION"]))
  })
})

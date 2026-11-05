import { randomBytes } from "node:crypto"
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The CLI the extension runs: the spinbox.cliPath setting when it names one, otherwise the copy of
// the CLI the VSIX carries in bin/<platform>/spin, installed into the extension's global storage.
// That path stays the same across versions of the extension, so the SSH config spin writes, which
// names it as the ProxyCommand, keeps working after the extension updates.
//
// The VSIX carries bin/<platform>/VERSION beside the binary: the spin release it is. The installed
// copy keeps its own VERSION beside it, and is replaced when the carried release is newer.

// spin's release names: spin-<os>-<arch>, as Go names them.
const GOOS: Partial<Record<NodeJS.Platform, string>> = { linux: "linux", darwin: "darwin" }
const GOARCH: Partial<Record<NodeJS.Architecture, string>> = { x64: "amd64", arm64: "arm64" }

export function platformDir(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | null {
  const os = GOOS[platform]
  const cpu = GOARCH[arch]
  return os && cpu ? `${os}-${cpu}` : null
}

// There is no spin to run: the setting names nothing runnable, or the VSIX carries no CLI for this
// platform. The way out is the spinbox.cliPath setting.
export class SpinNotFoundError extends Error {
  readonly path: string | null

  constructor(message: string, path: string | null) {
    super(message)
    this.name = "SpinNotFoundError"
    this.path = path
  }
}

export interface SpinBinaryOptions {
  // The extension's install directory (context.extensionPath).
  extensionPath: string
  // The extension's global storage directory (context.globalStorageUri.fsPath).
  storagePath: string
  // The spinbox.cliPath setting, read on each call so a change takes effect without a reload.
  cliPath: () => string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}

export class SpinBinary {
  private readonly opts: SpinBinaryOptions
  private installed: Promise<string> | undefined

  constructor(opts: SpinBinaryOptions) {
    this.opts = opts
  }

  // The spin to run. The carried one is installed at most once per instance; a failed install is
  // tried again on the next call.
  path(): Promise<string> {
    const configured = this.opts.cliPath().trim()
    if (configured !== "") {
      return Promise.resolve(configured)
    }
    if (!this.installed) {
      this.installed = this.install().catch((err: unknown) => {
        this.installed = undefined
        throw err
      })
    }
    return this.installed
  }

  private async install(): Promise<string> {
    const platform = this.opts.platform ?? process.platform
    const arch = this.opts.arch ?? process.arch
    const dir = platformDir(platform, arch)
    if (!dir) {
      throw new SpinNotFoundError(
        `Spinbox carries no spin CLI for ${platform}-${arch}: set spinbox.cliPath to one.`,
        null,
      )
    }
    const carried = join(this.opts.extensionPath, "bin", dir)
    const carriedVersion = await readVersion(join(carried, "VERSION"))
    if (carriedVersion === null) {
      throw new SpinNotFoundError(
        `Spinbox carries no spin CLI in ${carried}: set spinbox.cliPath to one.`,
        null,
      )
    }
    const target = join(this.opts.storagePath, "bin")
    const binary = join(target, "spin")
    const installedVersion = (await exists(binary))
      ? await readVersion(join(target, "VERSION"))
      : null
    if (installedVersion !== null && compareReleases(carriedVersion, installedVersion) <= 0) {
      return binary
    }
    await mkdir(target, { recursive: true })
    // Copied beside it and renamed over it, so a spin another window is running, or an SSH
    // connection starting, never sees half a binary.
    const tmp = join(target, `.spin-${process.pid}-${randomBytes(4).toString("hex")}`)
    try {
      await copyFile(join(carried, "spin"), tmp)
      await chmod(tmp, 0o755)
      await rename(tmp, binary)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    await writeFile(join(target, "VERSION"), `${carriedVersion}\n`)
    return binary
  }
}

// Orders two spin releases, vYYYYMMDD.NN.
export function compareReleases(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true })
}

async function readVersion(file: string): Promise<string | null> {
  try {
    const v = (await readFile(file, "utf8")).trim()
    return v === "" ? null : v
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

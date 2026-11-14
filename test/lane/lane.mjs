// What the lanes that open a spin e2e stack's workspaces in a real VS Code share
// (test/remote-ssh/run.mjs, test/spin-remote/run.mjs): VS Code stable, a person's home per case,
// a wrapper around spin that stamps each call, VS Code started in bubblewrap on a remote folder,
// and what each side logs, read back while the lane waits for what it is looking for.
//
// SPIN_STACK names the spin checkout whose stack is up (`task e2e:up` and `task e2e:workspaces`):
// its bin/spin, and the fixture user's home hack/e2estack keeps. Each case runs in bubblewrap with
// a home of its own bound over $HOME, since ssh finds ~/.ssh from the password database and not
// from HOME, so neither the CLI's ssh config nor the stack's session ever touches the real one.
import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron"

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const probe = join(root, "test/lane/testdata/probe")
export const say = (line) => console.log(`==> ${line}`)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function stackOf(env) {
  const stack = env.SPIN_STACK
  if (!stack) {
    console.error("SPIN_STACK: the spin checkout whose e2e stack is up")
    process.exit(2)
  }
  return {
    stack: resolve(stack),
    spin: resolve(stack, "bin/spin"),
    person: resolve(stack, "_output/run/e2e/people/user"),
  }
}

// VS Code stable, as people have it, with the extensions given (Marketplace ids or VSIX paths)
// installed into an extensions directory of the lane's own.
// The probe, packaged as any extension is and installed beside the others. Not loaded with
// --extensionDevelopmentPath: that makes the window an Extension Development Host, which VS Code
// closes when an extension host goes away - a remote's, when its connection drops - so no
// reconnect could be seen in it.
function packageProbe(work) {
  const out = join(work, "lane-probe.vsix")
  const r = spawnSync(
    join(root, "node_modules/.bin/vsce"),
    ["package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--out", out],
    { cwd: probe, encoding: "utf8" },
  )
  if (r.status !== 0) throw new Error(`packaging the probe: ${r.stderr || r.stdout}`)
  return out
}

export async function vscodeWith(work, extensions) {
  const exe = await downloadAndUnzipVSCode({
    version: "stable",
    cachePath: resolve(root, ".vscode-test"),
  })
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(exe)
  const version = spawnSync(cli, ["--version"], { encoding: "utf8" }).stdout.split("\n")
  const dir = join(work, "extensions")
  const installed = spawnSync(
    cli,
    [
      `--extensions-dir=${dir}`,
      `--user-data-dir=${join(work, "install")}`,
      ...[...extensions, packageProbe(work)].flatMap((e) => ["--install-extension", e]),
    ],
    { encoding: "utf8" },
  )
  if (installed.status !== 0) throw new Error(`installing the extensions: ${installed.stderr}`)
  const listed = readdirSync(dir).filter((d) => d.includes("."))
  say(`VS Code ${version[0]} (${version[1]}), ${listed.join(", ")}`)
  return { exe, extensions: dir, version: version[0], commit: version[1] }
}

// The person's home for one case: their session and the stack's root, and their enrolled key, or
// a key of nobody's.
const KEPT = [
  ".spin/config.yaml",
  ".trust/stack-root.pem",
  ".ssh/id_ed25519",
  ".ssh/id_ed25519.pub",
]

export function homeFor(person, dir, enrolled) {
  for (const f of KEPT) {
    mkdirSync(dirname(join(dir, f)), { recursive: true, mode: 0o700 })
    if (enrolled || !f.startsWith(".ssh/")) copyFileSync(join(person, f), join(dir, f))
  }
  if (!enrolled) {
    const key = join(dir, ".ssh/id_ed25519")
    const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key])
    if (r.status !== 0) throw new Error("ssh-keygen failed")
  }
}

// The CLI as the person, outside VS Code, for what the stack says of a workspace.
export function personCli(spin, person) {
  const run = (...args) => {
    const r = spawnSync(spin, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: person,
        SSL_CERT_DIR: `/etc/ssl/certs:${join(person, ".trust")}`,
      },
    })
    return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  const stateOf = (name) => {
    const r = run("-o", "json", "workspace", "list")
    if (!r.ok) throw new Error(`listing workspaces: ${r.err}`)
    return JSON.parse(r.out).items.find((w) => w.name === name)?.state
  }
  return { run, stateOf }
}

export const lines = (body) => body.split("\n").filter((l) => l !== "")
export const read = (path) => (existsSync(path) ? lines(readFileSync(path, "utf8")) : [])

// Every line VS Code's logs hold in the files whose names end with suffix.
export function logOf(userData, suffix) {
  const found = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(suffix)) found.push(...lines(readFileSync(p, "utf8")))
    }
  }
  if (existsSync(join(userData, "logs"))) walk(join(userData, "logs"))
  return found
}

// [hh:mm:ss.mmm] at the start of a Remote-SSH line, as epoch ms of the day it ran.
export function timeOf(line, day) {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line)
  if (m === null) return undefined
  const d = new Date(day)
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))
  return d.getTime()
}

// A spin around the real one that says each call with when it started and ended. The time is
// bash's own clock read, in ms: uutils' `date +%s%3N` mixed one instant's seconds with another's
// milliseconds on a loaded host, and wrote an end before its start.
function spinWrapper(dir, spin) {
  const calls = join(dir, "spin-calls.log")
  const wrapper = join(dir, "spin")
  const stamp = (what) => `t=\${EPOCHREALTIME/./}; echo "\${t%???} ${what} $*" >> ${calls}`
  writeFileSync(
    wrapper,
    `#!/bin/bash\n${stamp("start")}\n${spin} "$@"\nrc=$?\n${stamp("end $rc")}\nexit $rc\n`,
  )
  chmodSync(wrapper, 0o755)
  return { wrapper, calls }
}

// How long VS Code may take to quit when the probe asks it to.
const QUIT_MS = 15_000

export const SETTINGS = {
  "spinbox.telemetry": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false,
  // Every case opens the same workspaces, whose server keeps the terminals earlier windows left:
  // a new window would revive them all, every earlier case's probe terminal in this one's.
  "terminal.integrated.enablePersistentSessions": false,
  // VS Code asks once whether an extension may open a vscode:// link, in a modal nobody answers
  // here: the person who said yes, as they would to the dashboard's first link.
  "extensions.confirmedUriHandlerExtensionIds": ["spin-stack.spinbox"],
}

// openCase starts VS Code on folder in a home of the case's own and waits up to waitMs until
// until(seen, files) holds, then ends it and answers what was seen. settings(wrapper) is the
// user's settings, given the spin wrapper; homeFiles, files laid in the case's home before start
// (argv.json, say); logs, the VS Code log files to read, by name: suffix.
export async function openCase(lane, name, o) {
  const dir = join(lane.work, name)
  const caseHome = join(dir, "home")
  const userData = join(dir, "user-data")
  homeFor(lane.person, caseHome, o.enrolled)
  for (const [f, body] of Object.entries(o.homeFiles ?? {})) {
    mkdirSync(dirname(join(caseHome, f)), { recursive: true })
    writeFileSync(join(caseHome, f), body)
  }
  // An empty system ssh config: in bubblewrap's namespace root's files are nobody's, which ssh
  // refuses to read.
  writeFileSync(join(dir, "ssh_config"), "")
  const { wrapper, calls } = spinWrapper(dir, lane.spin)
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(
    join(userData, "User/settings.json"),
    JSON.stringify({ ...SETTINGS, ...o.settings(wrapper) }),
  )
  const files = {
    probe: join(dir, "probe.jsonl"),
    dismiss: join(dir, "dismiss"),
    again: join(dir, "again"),
    quit: join(dir, "quit"),
    userData,
  }
  const started = Date.now()
  const home = homedir()
  const bwrap = [
    ["--die-with-parent"],
    ["--dev-bind", "/", "/"],
    ["--bind", caseHome, home],
    ["--bind", root, root],
    ["--bind", lane.stack, lane.stack],
    ["--tmpfs", "/tmp"],
    // The lane's directory, under the /tmp just emptied: the extensions installed, and the case's
    // spin wrapper, the user data VS Code logs into and the probe's files.
    ["--bind", lane.work, lane.work],
    ["--bind", "/tmp/.X11-unix", "/tmp/.X11-unix"],
    ["--ro-bind", join(dir, "ssh_config"), "/etc/ssh/ssh_config"],
    ["--tmpfs", "/etc/ssh/ssh_config.d"],
    process.env.XAUTHORITY ? ["--bind", process.env.XAUTHORITY, process.env.XAUTHORITY] : [],
  ].flat()
  const code = spawn(
    "bwrap",
    [
      ...bwrap,
      lane.vscode.exe,
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${lane.vscode.extensions}`,
      `--folder-uri=${o.folder}`,
      "--log=trace",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--new-window",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SSL_CERT_DIR: `/etc/ssl/certs:${join(home, ".trust")}`,
        SPINBOX_PROBE_OUT: files.probe,
        SPINBOX_PROBE_DISMISS: files.dismiss,
        SPINBOX_PROBE_AGAIN: files.again,
        SPINBOX_PROBE_QUIT: files.quit,
      },
    },
  )
  const seen = () => {
    const s = {
      started,
      dir,
      probe: read(files.probe).map((l) => JSON.parse(l)),
      calls: read(calls),
      exthost: logOf(userData, "exthost.log"),
      renderer: logOf(userData, "renderer.log"),
    }
    for (const [key, suffix] of Object.entries(o.logs)) s[key] = logOf(userData, suffix)
    return s
  }
  let s = seen()
  const end = Date.now() + o.waitMs
  const exited = new Promise((r) =>
    code.once("exit", (c, sig) => r(`VS Code exited (${c ?? sig})`)),
  )
  let why
  while (why === undefined) {
    if (await o.until(s, files)) why = "seen"
    else if (Date.now() >= end) why = `not seen in ${o.waitMs / 1000} s`
    else why = await Promise.race([sleep(1_000), exited])
    s = seen()
  }
  say(`${name}: ${why}`)
  // Quit as a person does, so VS Code tells the workspace's server the window is gone and its
  // extension host ends: killed, the server keeps it for the reconnection's grace, three hours,
  // and a few cases filled the workspace's memory until it could start no process.
  if (!why.startsWith("VS Code exited")) {
    writeFileSync(files.quit, "")
    const quit = await Promise.race([exited, sleep(QUIT_MS).then(() => undefined)])
    if (quit === undefined) {
      say(`${name}: VS Code did not quit within ${QUIT_MS / 1000} s; ended`)
      try {
        process.kill(-code.pid, "SIGTERM")
      } catch {}
      await sleep(2_000)
    }
  }
  return seen()
}

// A lane: its stack, its VS Code, its work directory, and the checks it has made.
export async function lane(prefix, extensions) {
  const { stack, spin, person } = stackOf(process.env)
  const work = mkdtempSync(join(tmpdir(), prefix))
  const vscode = await vscodeWith(work, extensions)
  const failures = []
  const check = (name, ok, evidence) => {
    say(`${ok ? "ok  " : "FAIL"} ${name}`)
    for (const line of [evidence].flat().filter((l) => l !== undefined))
      console.log(`       ${line}`)
    if (!ok) failures.push(name)
  }
  const run = async (cases) => {
    const only = process.env.CASES?.split(",")
    for (const [name, c] of Object.entries(cases)) {
      if (only === undefined || only.includes(name)) await c()
    }
    say(`logs in ${work}`)
    if (failures.length > 0) {
      console.error(`${failures.length} failed: ${failures.join("; ")}`)
      process.exit(1)
    }
  }
  return { stack, spin, person, work, vscode, check, run, cli: personCli(spin, person) }
}

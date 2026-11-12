// The Spinbox VSIX and Microsoft's Remote-SSH, installed into a real VS Code stable, opening the
// workspaces of a spin e2e stack (spin's `task e2e:up` and `task e2e:workspaces`) the way a
// reconnect or a recent folder does: VS Code started on vscode-remote://ssh-remote+spin.<ws>, with
// nothing of Spinbox's run first. What src/remote/connect.ts claims is checked from what each
// side logs:
//
//   - running: Spinbox activates on onResolveRemoteAuthority:ssh-remote and its `spin code` ends
//     before Remote-SSH resolves the authority, Remote-SSH connects, and a command typed into the
//     window's terminal runs in the workspace;
//   - stopped: the same, with the workspace started by that `spin code --start`, and no error of
//     Remote-SSH's;
//   - unenrolled: with a key the account does not have, Spinbox says key_not_enrolled (whose
//     action is Add Key) and Remote-SSH waits while it is up. Once it is closed - READ_MS after it
//     is said, as a person reads it - Remote-SSH resolves once, spin ends its ssh at once (no
//     askpass, no ConnectTimeout), its error follows within seconds, and the window is local.
//
// SPIN_STACK names the spin checkout whose stack is up: its bin/spin, and the fixture user's home
// hack/e2estack keeps. Each case runs in bubblewrap with a home of its own bound over $HOME, since
// ssh finds ~/.ssh from the password database and not from HOME, so neither spin code's ssh config
// nor the stack's session ever touches the real one. CASES=running,stopped,unenrolled picks some.
// Needs bwrap, ssh-keygen and a display: `task test:remote-ssh` runs it under xvfb-run.
import { spawn, spawnSync } from "node:child_process"
import {
  appendFileSync,
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const stack = process.env.SPIN_STACK
if (!stack) {
  console.error("SPIN_STACK: the spin checkout whose e2e stack is up")
  process.exit(2)
}
const spin = resolve(stack, "bin/spin")
const person = resolve(stack, "_output/run/e2e/people/user")
const home = homedir()
const work = mkdtempSync(join(tmpdir(), "spinbox-remote-ssh-"))
const vsix = process.env.SPINBOX_VSIX ?? resolve(root, "spinbox.vsix")
const only = process.env.CASES?.split(",")
const WAIT_MS = 360_000
// How long the unenrolled case leaves Spinbox's message up before closing it.
const READ_MS = Number(process.env.READ_MS ?? 30_000)
// What "at once" is for a refused Remote-SSH: well under its 15 s ConnectTimeout.
const QUICK_MS = 5_000

const say = (line) => console.log(`==> ${line}`)

// VS Code stable, as Marketplace users have it, with Remote-SSH from the Marketplace beside the
// VSIX: neither is a development copy.
const exe = await downloadAndUnzipVSCode({
  version: "stable",
  cachePath: resolve(root, ".vscode-test"),
})
const [cli] = resolveCliArgsFromVSCodeExecutablePath(exe)
const version = spawnSync(cli, ["--version"], { encoding: "utf8" }).stdout.split("\n")
const extensions = join(work, "extensions")
const installed = spawnSync(
  cli,
  [
    `--extensions-dir=${extensions}`,
    `--user-data-dir=${join(work, "install")}`,
    "--install-extension",
    "ms-vscode-remote.remote-ssh",
    "--install-extension",
    vsix,
  ],
  { encoding: "utf8" },
)
if (installed.status !== 0) throw new Error(`installing the extensions: ${installed.stderr}`)
const listed = readdirSync(extensions).filter((d) => d.includes("."))
say(`VS Code ${version[0]} (${version[1]}), ${listed.join(", ")}`)

// The person's home for one case: their session and the stack's root, and their enrolled key, or
// a key of nobody's.
const KEPT = [
  ".spin/config.yaml",
  ".trust/stack-root.pem",
  ".ssh/id_ed25519",
  ".ssh/id_ed25519.pub",
]

function homeFor(dir, enrolled) {
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

const trust = `/etc/ssl/certs:${join(home, ".trust")}`

// The CLI as the person, outside VS Code, for what the stack says of a workspace.
function asPerson(...args) {
  const r = spawnSync(spin, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: person, SSL_CERT_DIR: `/etc/ssl/certs:${join(person, ".trust")}` },
  })
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() }
}

function stateOf(name) {
  const r = asPerson("-o", "json", "workspace", "list")
  if (!r.ok) throw new Error(`listing workspaces: ${r.err}`)
  return JSON.parse(r.out).items.find((w) => w.name === name)?.state
}

const lines = (body) => body.split("\n").filter((l) => l !== "")

// Every line VS Code's logs hold in the files whose names end with suffix.
function logOf(userData, suffix) {
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

const read = (path) => (existsSync(path) ? lines(readFileSync(path, "utf8")) : [])

// [hh:mm:ss.mmm] at the start of a Remote-SSH line, as epoch ms of the day it ran.
function timeOf(line, day) {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line)
  if (m === null) return undefined
  const d = new Date(day)
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))
  return d.getTime()
}

async function openCase(name, workspace, { enrolled, until }) {
  const dir = join(work, name)
  const caseHome = join(dir, "home")
  const userData = join(dir, "user-data")
  homeFor(caseHome, enrolled)
  // An empty system ssh config: in bubblewrap's namespace root's files are nobody's, which ssh
  // refuses to read.
  writeFileSync(join(dir, "ssh_config"), "")
  // Each spin the extension runs, said with when it started and ended, around the real one.
  const calls = join(dir, "spin-calls.log")
  const wrapper = join(dir, "spin")
  const stamp = (what) => `echo "$(date +%s%3N) ${what} $*" >> ${calls}`
  writeFileSync(
    wrapper,
    `#!/bin/sh\n${stamp("start")}\n${spin} "$@"\nrc=$?\n${stamp("end $rc")}\nexit $rc\n`,
  )
  chmodSync(wrapper, 0o755)
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(
    join(userData, "User/settings.json"),
    JSON.stringify({
      "spinbox.cliPath": wrapper,
      "spinbox.telemetry": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
    }),
  )
  const probeOut = join(dir, "probe.jsonl")
  const dismiss = join(dir, "dismiss")
  const folder = `vscode-remote://ssh-remote+spin.${workspace}/workspace`
  const started = Date.now()
  const bwrap = [
    ["--die-with-parent"],
    ["--dev-bind", "/", "/"],
    ["--bind", caseHome, home],
    ["--bind", root, root],
    ["--bind", resolve(stack), resolve(stack)],
    ["--tmpfs", "/tmp"],
    ["--bind", "/tmp/.X11-unix", "/tmp/.X11-unix"],
    ["--ro-bind", join(dir, "ssh_config"), "/etc/ssh/ssh_config"],
    ["--tmpfs", "/etc/ssh/ssh_config.d"],
    process.env.XAUTHORITY ? ["--bind", process.env.XAUTHORITY, process.env.XAUTHORITY] : [],
  ].flat()
  const code = spawn(
    "bwrap",
    [
      ...bwrap,
      exe,
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${join(root, "test/remote-ssh/testdata/probe")}`,
      `--folder-uri=${folder}`,
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
        SSL_CERT_DIR: trust,
        SPINBOX_PROBE_OUT: probeOut,
        SPINBOX_PROBE_DISMISS: dismiss,
      },
    },
  )
  const seen = () => ({
    started,
    probe: read(probeOut).map((l) => JSON.parse(l)),
    calls: read(calls),
    spinbox: logOf(userData, "Spinbox.log"),
    remoteSSH: logOf(userData, "Remote - SSH.log"),
    exthost: logOf(userData, "exthost.log"),
  })
  let s = seen()
  const end = Date.now() + WAIT_MS
  while (Date.now() < end && !until(s, dismiss)) {
    await new Promise((r) => setTimeout(r, 1_000))
    s = seen()
  }
  try {
    process.kill(-code.pid, "SIGTERM")
  } catch {}
  await new Promise((r) => setTimeout(r, 2_000))
  return seen()
}

const failures = []
function check(name, ok, evidence) {
  say(`${ok ? "ok  " : "FAIL"} ${name}`)
  for (const line of [evidence].flat().filter((l) => l !== undefined)) console.log(`       ${line}`)
  if (!ok) failures.push(name)
}

// Spinbox's activation by the resolution, the `spin code <workspace>` it ran and when that ended,
// and the first line Remote-SSH says resolving the authority with.
function ordering(s, workspace) {
  const activated = s.exthost.find(
    (l) =>
      l.includes("_doActivateExtension spin-stack.spinbox,") &&
      l.includes("onResolveRemoteAuthority:ssh-remote"),
  )
  const start = s.calls.find((l) => / start code /.test(l) && l.includes(` ${workspace} `))
  const end = s.calls.find((l) => / end \d+ code /.test(l) && l.includes(` ${workspace} `))
  const resolving = s.remoteSSH.find((l) => /SSH Resolver called/.test(l))
  return {
    activated,
    start,
    end,
    endMs: end === undefined ? undefined : Number(end.split(" ")[0]),
    rc: end === undefined ? undefined : Number(end.split(" ")[2]),
    resolving,
    resolvingMs: resolving === undefined ? undefined : timeOf(resolving, s.started),
  }
}

// What Remote-SSH says when it gives up on a connection; its server's own lines ([server]) are the
// remote's, and say nothing of the connection.
const GAVE_UP = /resolver error|could not establish|failed to connect|connection (closed|refused)/i
const errorsOf = (s) => s.remoteSSH.filter((l) => !l.includes("[server]") && GAVE_UP.test(l))

const connected = (s) => s.probe.some((e) => e.event === "terminal")

async function connects(name, workspace) {
  const s = await openCase(name, workspace, { enrolled: true, until: connected })
  const o = ordering(s, workspace)
  check(
    `${name}: Spinbox ran spin code --start before Remote-SSH resolved`,
    o.activated !== undefined &&
      o.rc === 0 &&
      o.start?.includes("--start") &&
      o.endMs <= o.resolvingMs,
    [o.activated?.slice(0, 160), o.start, o.end, `Remote-SSH: ${o.resolving}`],
  )
  const t = s.probe.find((e) => e.event === "terminal")
  const there = t?.output ? asPerson("exec", workspace, "--no-tty", "--", "cat", t.path) : undefined
  check(
    `${name}: a command run in the window's terminal ran in ${workspace}`,
    there?.ok === true && there.out === t.output,
    [`terminal wrote ${t?.path}: ${t?.output}`, `spin exec ${workspace} cat: ${there?.out}`],
  )
  const errors = errorsOf(s)
  check(`${name}: Remote-SSH said no error`, errors.length === 0, errors.slice(0, 5))
}

const cases = {
  running: async () => {
    const state = stateOf("e2e-running")
    check("running: e2e-running is running", state === "WORKSPACE_STATE_RUNNING", state)
    await connects("running", "e2e-running")
  },
  stopped: async () => {
    const before = stateOf("e2e-stopped")
    check("stopped: e2e-stopped is stopped", before === "WORKSPACE_STATE_STOPPED", before)
    await connects("stopped", "e2e-stopped")
    const after = stateOf("e2e-stopped")
    check("stopped: Spinbox started it", after === "WORKSPACE_STATE_RUNNING", after)
    // Left as e2e:workspaces makes it, for the next run.
    asPerson("workspace", "stop", "e2e-stopped", "--wait", "--timeout", "3m")
  },
  unenrolled: async () => {
    let refusedAt
    const s = await openCase("unenrolled", "e2e-running", {
      enrolled: false,
      until: (s, dismiss) => {
        if (refusedAt === undefined && s.spinbox.some((l) => l.includes("[key_not_enrolled]"))) {
          refusedAt = Date.now()
        }
        if (
          refusedAt !== undefined &&
          Date.now() - refusedAt >= READ_MS &&
          !s.probe.some((e) => e.event === "dismissed") &&
          !existsSync(dismiss)
        ) {
          appendFileSync(dismiss, "")
        }
        const activations = s.probe.filter((e) => e.event === "activate")
        return activations.length >= 2 && activations.at(-1).remoteName === null
      },
    })
    const refused = s.spinbox.find((l) => l.includes("[key_not_enrolled]"))
    check(
      "unenrolled: Spinbox showed key_not_enrolled (Add Key)",
      refused !== undefined,
      refused?.slice(0, 160),
    )
    const o = ordering(s, "e2e-running")
    const dismissed = s.probe.find((e) => e.event === "dismissed")
    check(
      "unenrolled: Remote-SSH did not resolve while the message was up",
      o.resolving === undefined || o.resolvingMs >= dismissed?.t,
      [o.end, `message closed at ${dismissed?.t}`, `Remote-SSH: ${o.resolving}`],
    )
    // Then Remote-SSH connects once anyway (src/remote/connect.ts), and is ended at once by spin's
    // ssh-proxy: no askpass box, no wait for its ConnectTimeout.
    const gaveUp = errorsOf(s)[0]
    const gaveUpMs = gaveUp === undefined ? undefined : timeOf(gaveUp, s.started)
    check(
      `unenrolled: Remote-SSH's error came within ${QUICK_MS / 1000} s of its resolver`,
      o.resolvingMs !== undefined && gaveUpMs !== undefined && gaveUpMs - o.resolvingMs <= QUICK_MS,
      [o.resolving, gaveUp],
    )
    const asked = s.remoteSSH.filter((l) => /askpass request|banner exchange/i.test(l))
    check("unenrolled: Remote-SSH's ssh asked nothing and waited for nothing", asked.length === 0, [
      ...asked.slice(0, 3),
      s.remoteSSH.find((l) => l.includes("as the editor already said")),
    ])
    const left = s.probe.filter((e) => e.event === "activate").at(-1)
    check(
      `unenrolled: the window left the remote within ${QUICK_MS / 1000} s of the message closing`,
      left?.remoteName === null && dismissed !== undefined && left.t - dismissed.t <= QUICK_MS,
      `message closed at ${dismissed?.t}, window local at ${left?.t} (remoteName=${left?.remoteName})`,
    )
  },
}

for (const [name, run] of Object.entries(cases)) {
  if (only === undefined || only.includes(name)) await run()
}
say(`logs in ${work}`)
if (failures.length > 0) {
  console.error(`${failures.length} failed: ${failures.join("; ")}`)
  process.exit(1)
}

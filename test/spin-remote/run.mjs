// Spinbox Remote (spin-stack.spinbox-remote, spin-stack/open-remote-ssh) and the Spinbox VSIX,
// installed into a real VS Code stable, opening the workspaces of a spin e2e stack as
// vscode-remote://spin+<workspace>, as Spinbox opens them when the resolver is active and as a
// reconnect or a recent folder does. No Remote-SSH is installed: spin+ needs none. The proposed
// API the resolver runs on is enabled the way a person enables it, by argv.json in their home.
// What each case asserts is what the person sees, read from VS Code's logs, the probe and the stack:
//
//   - running: the resolver activates on onResolveRemoteAuthority:spin, runs spin code,
//     ssh-session and tunnel in that order, and a command typed into the window's terminal runs in
//     the workspace;
//   - stopped: the same, with the workspace started by the resolver's spin code --start;
//   - reconnect: the connection's ssh and tunnel killed under a connected window, as a network that
//     drops does: VS Code resolves again, the window is back within RECONNECT_MS, and the terminal
//     it had is the same shell;
//   - unenrolled: with a key the account does not have, the resolver refuses with
//     key_not_enrolled, says it once, and VS Code neither retries nor connects;
//   - reuse: the dashboard's link for the workspace open in the window, by its id, handed to the
//     running VS Code: Spinbox opens it, and VS Code brings that window rather than another
//     (spin#1119: the dashboard learns nothing back, so the window has to be found here);
//   - moved (only when CASES names it, with spin's `task e2e:hosts:up` run first): the workspace
//     moved to another host under a connected window: VS Code resolves again, to the new host's
//     key, and the terminal is the same shell. It fails until spin#1225: the reconnect's start
//     resumes the workspace where it was, and the move aborts.
//
// SPIN_STACK names the spin checkout whose stack is up (test/lane/lane.mjs says what it runs each
// case in); SPINBOX_REMOTE_VSIX, Spinbox Remote's VSIX (its `task package`, or a release's).
// CASES=running,stopped,reconnect,unenrolled,reuse picks some. `task test:spin-remote` runs it.
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, openSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { lane, logOf, openCase, root } from "../lane/lane.mjs"

const RESOLVER = "spin-stack.spinbox-remote"
const vsix = process.env.SPINBOX_VSIX ?? resolve(root, "spinbox.vsix")
const remoteVsix = process.env.SPINBOX_REMOTE_VSIX
if (!remoteVsix) {
  console.error("SPINBOX_REMOTE_VSIX: Spinbox Remote's VSIX (open-remote-ssh's task package)")
  process.exit(2)
}
const WAIT_MS = 360_000
// How long a window that lost its connection may take to be back: VS Code noticing, its resolve,
// the resolver's spin code, ssh-session and login, and the server reached again.
const RECONNECT_MS = Number(process.env.RECONNECT_MS ?? 60_000)
// How long a reconnected window's terminal may take to answer.
const ANSWER_MS = 20_000
// How long the unenrolled case watches after the refusal for a retry that must not come.
const SETTLE_MS = 15_000

const lab = await lane("spinbox-spin-remote-", [vsix, remoteVsix])
const { check } = lab
const stateOf = lab.cli.stateOf
const asPerson = lab.cli.run

function open(name, workspace, { enrolled = true, until }) {
  return openCase(lab, name, {
    enrolled,
    until,
    waitMs: WAIT_MS,
    folder: `vscode-remote://spin+${workspace}/workspace`,
    settings: (wrapper) => ({ "spinbox.cliPath": wrapper, "remote.spin.cliPath": wrapper }),
    homeFiles: {
      ".vscode/argv.json": JSON.stringify({ "enable-proposed-api": [RESOLVER] }),
    },
    logs: { remote: "Spinbox Remote.log", spinbox: "Spinbox.log" },
  })
}

// The spin subcommands the resolver ran for workspace, in order, with each one's exit code.
function callsOf(s, workspace) {
  return s.calls
    .map((l) => /^(\d+) end (\d+) (\S+) (.*)$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ t: Number(m[1]), rc: Number(m[2]), cmd: m[3], args: m[4] }))
    .filter((c) => c.cmd === "tunnel" || c.args.startsWith(`${workspace} `) || c.args === workspace)
}

const opened = (s) => s.remote.filter((l) => /open on 127\.0\.0\.1:\d+/.test(l))
const resolving = (s) => s.remote.filter((l) => /Resolving Spinbox workspace/.test(l))
const terminal = (s, event = "terminal") => s.probe.find((e) => e.event === event)
const connected = (s) => terminal(s)?.output != null
// The probe said what its terminal wrote, or that it could not read it back: either way, done.
const answered = (s) => terminal(s) !== undefined

// The shell a probe line was written from: hostname, user, the shell's pid, the folder.
const shellOf = (output) => output?.split(" ")[2]

function activatedBySpin(s) {
  return s.exthost.find(
    (l) =>
      l.includes(`_doActivateExtension ${RESOLVER},`) &&
      l.includes("onResolveRemoteAuthority:spin"),
  )
}

async function connects(name, workspace) {
  const s = await open(name, workspace, { until: answered })
  const activated = activatedBySpin(s)
  const calls = callsOf(s, workspace)
  const order = calls.map((c) => c.cmd)
  check(
    `${name}: Spinbox Remote activated on the spin+ authority and ran spin code, ssh-session, tunnel`,
    activated !== undefined &&
      order.indexOf("code") === 0 &&
      order.indexOf("ssh-session") > 0 &&
      calls.find((c) => c.cmd === "code")?.args.includes("--start") &&
      calls.filter((c) => c.cmd !== "tunnel").every((c) => c.rc === 0) &&
      s.calls.some((l) => / start tunnel /.test(l)),
    [activated?.slice(0, 160), ...s.calls.slice(0, 6)],
  )
  const win = s.probe.find((e) => e.event === "activate")
  check(`${name}: the window is a spin remote`, win?.remoteName === "spin", JSON.stringify(win))
  const t = terminal(s)
  const there = t?.output ? asPerson("exec", workspace, "--no-tty", "--", "cat", t.path) : undefined
  check(
    `${name}: a command run in the window's terminal ran in ${workspace}`,
    there?.ok === true && there.out === t.output,
    [`terminal wrote ${t?.path}: ${t?.output}`, `spin exec ${workspace} cat: ${there?.out}`],
  )
  const errors = s.remote.filter((l) => l.startsWith("[Error"))
  check(`${name}: Spinbox Remote logged no error`, errors.length === 0, errors.slice(0, 5))
}

// A connected window has its connection cut by cut(seen), then is asked for another line from its
// terminal once the resolver has opened the workspace again, which it claims within backMs.
async function survives(name, workspace, cut, backMs = RECONNECT_MS) {
  let cutAt
  let askedAt
  const s = await open(name, workspace, {
    until: (s, { again }) => {
      if (!answered(s)) return false
      if (!connected(s)) return true
      if (cutAt === undefined) {
        cutAt = Date.now()
        cut(s)
        return false
      }
      if (askedAt === undefined && opened(s).length >= 2) {
        askedAt = Date.now()
        appendFileSync(again, "")
      }
      // Not back in the time the case claims, or back without the terminal answering soon
      // after: failed, and waiting longer would only make it slower to say so.
      if (askedAt === undefined) return Date.now() - cutAt > backMs
      return terminal(s, "again")?.output != null || Date.now() - askedAt > ANSWER_MS
    },
  })
  const first = terminal(s)
  const second = terminal(s, "again")
  const reopened = opened(s)
  check(
    `${name}: VS Code resolved spin+${workspace} again and the resolver opened it again`,
    resolving(s).length >= 2 && reopened.length >= 2,
    [...resolving(s), ...reopened],
  )
  check(
    `${name}: the window was back within ${backMs / 1000} s`,
    askedAt !== undefined && askedAt - cutAt <= backMs,
    `cut at ${cutAt}, opened again at ${askedAt}: ${askedAt - cutAt} ms`,
  )
  check(
    `${name}: the terminal is the same shell`,
    second?.output != null && shellOf(second.output) === shellOf(first?.output),
    [`before: ${first?.output}`, `after: ${second?.output}`],
  )
  return s
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
    check("stopped: the resolver started it", after === "WORKSPACE_STATE_RUNNING", after)
    // Left as e2e:workspaces makes it, for the next run.
    asPerson("workspace", "stop", "e2e-stopped", "--wait", "--timeout", "3m")
  },
  reconnect: async () => {
    // What a dropped network leaves: each spin tunnel the window's ssh rides on gone at once,
    // the real spin with the wrapper around it, so ssh reads the end of its connection.
    await survives("reconnect", "e2e-running", (s) => {
      for (const l of s.calls) {
        const session = / start tunnel (\S+)$/.exec(l)?.[1]
        if (session) {
          const who = spawnSync("pgrep", ["-a", "-f", `tunnel ${session}`], {
            encoding: "utf8",
          }).stdout
          console.log(`       cutting: ${who.trim().replaceAll("\n", " | ")}`)
          spawnSync("pkill", ["-KILL", "-f", `tunnel ${session}`])
        }
      }
    })
  },
  unenrolled: async () => {
    let refusedAt
    const s = await open("unenrolled", "e2e-running", {
      enrolled: false,
      until: (s) => {
        if (refusedAt === undefined && s.remote.some((l) => l.includes("Spinbox refused"))) {
          refusedAt = Date.now()
        }
        return refusedAt !== undefined && Date.now() - refusedAt >= SETTLE_MS
      },
    })
    const refused = s.remote.find((l) => l.includes("Spinbox refused"))
    check(
      "unenrolled: Spinbox Remote refused with key_not_enrolled",
      refused?.includes("key_not_enrolled") === true,
      refused,
    )
    check(
      "unenrolled: VS Code resolved once and did not try again",
      resolving(s).length === 1,
      resolving(s),
    )
    check(
      "unenrolled: no connection was made: no tunnel, no terminal",
      !s.calls.some((l) => / start tunnel /.test(l)) && terminal(s) === undefined,
      s.calls,
    )
  },
}

// The windows VS Code opened in a case: each has a log directory of its own.
function windowsOf(userData) {
  const logs = join(userData, "logs")
  if (!existsSync(logs)) return []
  return readdirSync(logs).flatMap((session) =>
    readdirSync(join(logs, session)).filter((d) => d.startsWith("window")),
  )
}

// The dashboard's link for a workspace, handed to the VS Code that is running, as the OS hands it.
function openLink(userData, workspace) {
  const out = openSync(join(userData, "open-url.log"), "a")
  spawn(
    lab.vscode.exe,
    [
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${lab.vscode.extensions}`,
      "--open-url",
      `vscode://spin-stack.spinbox/open?workspace=${workspace}`,
    ],
    { detached: true, stdio: ["ignore", out, out], env: process.env },
  ).unref()
}

// How long the reuse case watches for a second window after the link.
const LINK_MS = 30_000

cases.reuse = async () => {
  // By its id, as the dashboard's link names it: the window was opened by its name.
  const id = JSON.parse(asPerson("-o", "json", "workspace", "get", "e2e-running").out).id
  let sentAt
  let userData
  const s = await open("reuse", "e2e-running", {
    until: (s, files) => {
      if (!answered(s)) return false
      if (!connected(s)) return true
      if (sentAt === undefined) {
        sentAt = Date.now()
        userData = files.userData
        openLink(userData, id)
      }
      return windowsOf(userData).length > 1 || Date.now() - sentAt > LINK_MS
    },
  })
  const handled = s.spinbox.filter((l) => l.includes("spin code"))
  check(
    "reuse: Spinbox handled the dashboard's link",
    s.calls.some((l) => l.includes(` end 0 code ${id} `) && Number(l.split(" ")[0]) >= sentAt),
    [...s.calls.filter((l) => / code /.test(l)), ...handled],
  )
  const windows = windowsOf(userData)
  // VS Code's own word that the folder asked for was the open window's.
  const reused = logOf(userData, "main.log").filter((l) =>
    l.includes("doOpenFilesInExistingWindow"),
  )
  check(
    "reuse: the link brought the window already open to e2e-running, and opened no other",
    windows.length === 1 && reused.length > 0,
    [...windows, ...reused.map((l) => l.slice(0, 100))],
  )
}

// A move needs a second host (spin's task e2e:hosts:up), so it runs when asked for. It pauses the
// workspace while its memory is stored and its disk published, which takes minutes.
const MOVE_MS = Number(process.env.MOVE_MS ?? 600_000)
if (process.env.CASES?.split(",").includes("moved")) {
  cases.moved = async () => {
    const hostOf = () =>
      JSON.parse(asPerson("-o", "json", "workspace", "get", "e2e-running").out).hostId
    const before = hostOf()
    let moved
    await survives(
      "moved",
      "e2e-running",
      () => {
        // Not waited for here: the window is watched while the workspace moves under it.
        moved = new Promise((done) => {
          const p = spawn(lab.spin, ["workspace", "move", "e2e-running"], {
            env: {
              ...process.env,
              HOME: lab.person,
              SSL_CERT_DIR: `/etc/ssl/certs:${lab.person}/.trust`,
            },
          })
          let said = ""
          p.stdout.on("data", (d) => {
            said += d
          })
          p.stderr.on("data", (d) => {
            said += d
          })
          p.on("close", (code) => done({ code, said: said.trim(), at: Date.now() }))
        })
      },
      MOVE_MS,
    )
    const m = await moved
    check("moved: spin workspace move succeeded", m?.code === 0, m?.said)
    const after = hostOf()
    check(
      "moved: e2e-running runs on another host",
      before !== undefined && after !== undefined && after !== before,
      `${before} -> ${after}`,
    )
  }
}

await lab.run(cases)

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
import { appendFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { lane, openCase, root, timeOf } from "../lane/lane.mjs"

const vsix = process.env.SPINBOX_VSIX ?? resolve(root, "spinbox.vsix")
const WAIT_MS = 360_000
// How long the unenrolled case leaves Spinbox's message up before closing it.
const READ_MS = Number(process.env.READ_MS ?? 30_000)
// What "at once" is for a refused Remote-SSH's ssh: well under its 15 s ConnectTimeout.
const QUICK_MS = 5_000
// How long the window may take to start again, local: Remote-SSH's local server and its ssh, then
// the unload - 10 s on a host at load 22. Waiting out the ConnectTimeout alone took 17 s.
const LEAVE_MS = 15_000

// VS Code stable, as Marketplace users have it, with Remote-SSH from the Marketplace beside the
// VSIX: neither is a development copy.
const lab = await lane("spinbox-remote-ssh-", ["ms-vscode-remote.remote-ssh", vsix])
const { check } = lab
const stateOf = lab.cli.stateOf
const asPerson = lab.cli.run

function open(name, workspace, { enrolled, until }) {
  return openCase(lab, name, {
    enrolled,
    until,
    waitMs: WAIT_MS,
    folder: `vscode-remote://ssh-remote+spin.${workspace}/workspace`,
    settings: (wrapper) => ({ "spinbox.cliPath": wrapper }),
    logs: { spinbox: "Spinbox.log", remoteSSH: "Remote - SSH.log" },
  })
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
  const s = await open(name, workspace, { enrolled: true, until: connected })
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
    const s = await open("unenrolled", "e2e-running", {
      enrolled: false,
      until: (s, { dismiss }) => {
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
    // From Remote-SSH's ssh: what comes before it is Remote-SSH starting its local server.
    const spawned = s.remoteSSH.find((l) => /Spawned ssh, pid=/.test(l))
    const spawnedMs = spawned === undefined ? undefined : timeOf(spawned, s.started)
    const gaveUp = errorsOf(s)[0]
    const gaveUpMs = gaveUp === undefined ? undefined : timeOf(gaveUp, s.started)
    check(
      `unenrolled: Remote-SSH's error came within ${QUICK_MS / 1000} s of its ssh`,
      spawnedMs !== undefined && gaveUpMs !== undefined && gaveUpMs - spawnedMs <= QUICK_MS,
      [o.resolving, spawned, gaveUp],
    )
    const asked = s.remoteSSH.filter((l) => /askpass request|banner exchange/i.test(l))
    check("unenrolled: Remote-SSH's ssh asked nothing and waited for nothing", asked.length === 0, [
      ...asked.slice(0, 3),
      s.remoteSSH.find((l) => l.includes("as the editor already said")),
    ])
    // The window that replaces the remote one starts when the renderer starts up again; the
    // probe's activation in it says it is local, and comes when its extension host does, later.
    const reopened = s.renderer.filter((l) => l.includes("[lifecycle] starting up"))[1]
    const reopenedMs = reopened === undefined ? undefined : Date.parse(reopened.slice(0, 23))
    const left = s.probe.filter((e) => e.event === "activate").at(-1)
    check(
      `unenrolled: the window left the remote within ${LEAVE_MS / 1000} s of the message closing`,
      left?.remoteName === null &&
        dismissed !== undefined &&
        reopenedMs !== undefined &&
        reopenedMs - dismissed.t <= LEAVE_MS,
      [
        `message closed at ${new Date(dismissed?.t).toISOString()}`,
        `window started again: ${reopened}`,
        `probe in it: remoteName=${left?.remoteName}`,
      ],
    )
  },
}

await lab.run(cases)

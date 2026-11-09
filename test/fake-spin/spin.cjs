#!/usr/bin/env node
// A fake spin CLI that answers as the contract in spin-stack/spin#833 says the real one does, so
// the extension is tested against every answer and every error code without an installation.
//
// What it answers, per command (version, login, workspace list, code, or any other):
//
//   FAKE_SPIN_ERROR=<code>      every command fails with that code's envelope, exit 1
//   FAKE_SPIN_SCENARIO=<file>   a JSON object keyed by command ("version", "workspace list", ...,
//                               "*" for any): {"stdout": [<object>, ...], "stderr": "<text>",
//                               "exit": <n>, "delayMs": <n>} or {"error": "<code>", "message",
//                               "action", "release", "workspace_id", "url", "delayMs"}. A command it does not name gets the default answer.
//   FAKE_SPIN_LOGIN_DELAY_MS    how long login waits between its two lines (default 0)
//   FAKE_SPIN_LOG=<file>        every invocation's arguments appended as one JSON line
//
// With neither, each command answers the contract's example. Without -o json it refuses, exit 2:
// the extension never runs a command without it.
"use strict"

const fs = require("node:fs")

const ACTION_OF = {
  cli_outdated: "update",
  not_signed_in: "login",
  workspace_stopped: "start",
  workspace_failed: "open_dashboard",
  access_needs_signature: "sign",
  keyring_needs_signature: "sign_keyring",
  no_key_held: "add_key",
  no_capacity: "retry",
  unreachable: "retry",
  no_vscode_server: "details",
  internal: "details",
}

const USER = { id: "u-1", email: "dev@example.com", name: "Dev" }
const ENDPOINT = "https://app.spinbox.test"

const WORKSPACE = {
  id: "ws-1",
  name: "my-ws",
  teamId: "t-1",
  hostId: "h-1",
  image: "ghcr.io/spin-stack/base:latest",
  resources: {
    cpuCores: 2,
    memoryMb: 4096,
    diskGb: 20,
    maxCpuCores: 0,
    maxMemoryMb: 0,
    bandwidthMbps: 0,
  },
  state: "WORKSPACE_STATE_RUNNING",
  url: "https://my-ws.spinbox.test",
  env: {},
  createdAt: "2026-11-05T10:00:00Z",
  updatedAt: "2026-11-05T10:01:00Z",
  snapshotCount: 0,
  failureReason: "",
  networkTags: [],
  hostConnected: true,
  waitingReason: "",
  failure: "WORKSPACE_FAILURE_UNSPECIFIED",
  networkWatch: false,
  floorCpuCores: 2,
  floorMemoryMb: 4096,
  quarantineHeld: false,
  allowedActions: ["WORKSPACE_ACTION_STOP", "WORKSPACE_ACTION_SUSPEND", "WORKSPACE_ACTION_DELETE"],
  failureSummary: "",
  readyAt: "2026-11-05T10:01:00Z",
  traceId: "",
  role: "owner",
  accessSigned: true,
  memoryMachineGone: false,
  suspendsFor: "WORKSPACE_EVENT_TYPE_UNSPECIFIED",
  leases: [],
  projectId: "",
  ref: "",
  wakeOnAccess: false,
  suspendedSnapshotId: "",
  fromPrebuildId: "",
  agentMinMemoryMb: 0,
  projectError: "",
}

const DEFAULTS = {
  version: {
    stdout: [
      {
        cli: "v20261105.01",
        profile: "default",
        endpoint: ENDPOINT,
        signed_in: true,
        installation: "v20261105.01",
        user: USER,
      },
    ],
  },
  login: {
    stdout: [
      {
        verification_url: `${ENDPOINT}/device?code=ABCD-EFGH`,
        user_code: "ABCD-EFGH",
        expires_in: 600,
      },
      { profile: "default", endpoint: ENDPOINT, user: USER },
    ],
  },
  "workspace list": { stdout: [{ items: [WORKSPACE] }] },
  code: {
    stdout: [
      {
        workspace_id: "ws-1",
        host: "spin.my-ws",
        folder_uri: "vscode-remote://ssh-remote+spin.my-ws/root",
        server: "carried",
      },
    ],
  },
  "*": { stdout: [{}] },
}

// The flags that take a value, so the command is what is left once they are dropped.
const VALUED = new Set([
  "-o",
  "--output",
  "--endpoint",
  "--vscode-commit",
  "--vscode-version",
  "--traceparent",
  "--profile",
])

function parse(argv) {
  const words = []
  let output = "text"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-o" || a === "--output") {
      output = argv[++i]
    } else if (a.startsWith("--output=")) {
      output = a.slice("--output=".length)
    } else if (VALUED.has(a)) {
      i++
    } else if (!a.startsWith("-")) {
      words.push(a)
    }
  }
  const command = words[0] === "workspace" ? words.slice(0, 2).join(" ") : (words[0] ?? "")
  return { command, output }
}

function envelope(code, extra) {
  if (!Object.hasOwn(ACTION_OF, code)) {
    throw new Error(`fake spin: unknown error code ${code}`)
  }
  // A scenario may set any envelope field, the action among them to answer one that is wrong.
  const fields = {}
  for (const k of ["message", "action", "release", "workspace_id", "url"]) {
    if (extra && k in extra) {
      fields[k] = extra[k]
    }
  }
  return {
    stdout: [
      {
        error: {
          code,
          message: `fake ${code}`,
          action: ACTION_OF[code],
          ...(code === "cli_outdated" ? { release: "v20261105.01" } : {}),
          ...(code === "keyring_needs_signature"
            ? { url: "https://term.spinbox.test/#/sign" }
            : {}),
          ...fields,
        },
      },
    ],
    exit: 1,
  }
}

function answer(command) {
  if (process.env.FAKE_SPIN_ERROR) {
    return envelope(process.env.FAKE_SPIN_ERROR)
  }
  let scenario = {}
  if (process.env.FAKE_SPIN_SCENARIO) {
    scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SPIN_SCENARIO, "utf8"))
  }
  const a = scenario[command] ?? scenario["*"]
  if (a?.error) {
    return { ...envelope(a.error, a), delayMs: a.delayMs }
  }
  return a ?? DEFAULTS[command] ?? DEFAULTS["*"]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const argv = process.argv.slice(2)
  if (process.env.FAKE_SPIN_LOG) {
    fs.appendFileSync(process.env.FAKE_SPIN_LOG, `${JSON.stringify(argv)}\n`)
  }
  const { command, output } = parse(argv)
  if (output !== "json") {
    process.stderr.write("fake spin: run without -o json\n")
    return 2
  }
  const a = answer(command)
  await sleep(a.delayMs ?? 0)
  if (a.stderr) {
    process.stderr.write(a.stderr)
  }
  const lines = a.stdout ?? []
  for (const [i, line] of lines.entries()) {
    if (command === "login" && i > 0) {
      await sleep(Number(process.env.FAKE_SPIN_LOGIN_DELAY_MS ?? 0))
    }
    process.stdout.write(`${JSON.stringify(line)}\n`)
  }
  return a.exit ?? 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 3
  },
)

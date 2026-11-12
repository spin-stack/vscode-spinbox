// The lane's eyes in the window (test/remote-ssh/run.mjs): each thing it sees is a JSON line
// appended to SPINBOX_PROBE_OUT. It activates as Spinbox does, on the resolution of ssh-remote,
// so it is there while Spinbox's activation holds Remote-SSH back, and again in the window a
// closed remote leaves.
//
//   - activate: the remote the window is for, and its folder;
//   - terminal: in a window connected to a workspace, what a command run in its terminal wrote,
//     read back over the remote's file system;
//   - dismissed: the notifications closed when the lane asked, by creating SPINBOX_PROBE_DISMISS,
//     as a person closes one: a notification nobody answers holds its caller forever.
const fs = require("node:fs")
const vscode = require("vscode")

const out = process.env.SPINBOX_PROBE_OUT
const dismiss = process.env.SPINBOX_PROBE_DISMISS

function say(event, fields = {}) {
  if (out) fs.appendFileSync(out, `${JSON.stringify({ t: Date.now(), event, ...fields })}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

exports.activate = () => {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri
  say("activate", { remoteName: vscode.env.remoteName ?? null, folder: folder?.toString() ?? null })
  if (dismiss) void dismissWhenAsked()
  if (vscode.env.remoteName === "ssh-remote" && folder !== undefined) void runInTerminal(folder)
}

async function dismissWhenAsked() {
  for (;;) {
    if (fs.existsSync(dismiss)) {
      fs.rmSync(dismiss, { force: true })
      await vscode.commands.executeCommand("notifications.clearAll")
      say("dismissed")
    }
    await sleep(500)
  }
}

// The terminal opens once the remote is connected; until then the file is not there to read.
async function runInTerminal(folder) {
  const path = `/tmp/remote-ssh-probe-${process.pid}-${Date.now()}`
  const terminal = vscode.window.createTerminal({ name: "remote-ssh probe" })
  terminal.sendText(`echo "$(hostname) $(id -un) $PWD" > ${path}`)
  const file = folder.with({ path })
  const end = Date.now() + 300_000
  while (Date.now() < end) {
    try {
      const body = Buffer.from(await vscode.workspace.fs.readFile(file))
        .toString("utf8")
        .trim()
      if (body !== "") {
        say("terminal", { path, output: body })
        return
      }
    } catch {}
    await sleep(1_000)
  }
  say("terminal", { path, output: null })
}

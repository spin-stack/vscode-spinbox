// The lanes' eyes in the window (test/lane/lane.mjs): each thing it sees is a JSON line appended
// to SPINBOX_PROBE_OUT. It activates on the resolution of either remote, as Spinbox and Spinbox
// Remote do, so it is there while a resolution is held, and again in the window a closed remote
// leaves.
//
//   - activate: the remote the window is for, and its folder;
//   - terminal: in a window connected to a workspace, what a command run in its terminal wrote,
//     read back over the remote's file system;
//   - again: the same terminal asked for another command, when the lane creates
//     SPINBOX_PROBE_AGAIN - after a reconnect, whether the terminal outlived it;
//   - dismissed: the notifications closed when the lane asked, by creating SPINBOX_PROBE_DISMISS,
//     as a person closes one: a notification nobody answers holds its caller forever.
const fs = require("node:fs")
const vscode = require("vscode")

const out = process.env.SPINBOX_PROBE_OUT
const dismiss = process.env.SPINBOX_PROBE_DISMISS
const again = process.env.SPINBOX_PROBE_AGAIN
const REMOTES = ["ssh-remote", "spin"]

function say(event, fields = {}) {
  if (out) fs.appendFileSync(out, `${JSON.stringify({ t: Date.now(), event, ...fields })}\n`)
}

// How long a command's output may take to be read back once the remote answers.
const READ_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

exports.activate = () => {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri
  say("activate", { remoteName: vscode.env.remoteName ?? null, folder: folder?.toString() ?? null })
  if (dismiss)
    void whenAsked(dismiss, async () => {
      await vscode.commands.executeCommand("notifications.clearAll")
      say("dismissed")
    })
  if (REMOTES.includes(vscode.env.remoteName) && folder !== undefined) void runInTerminal(folder)
}

async function whenAsked(file, act) {
  for (;;) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      await act()
    }
    await sleep(500)
  }
}

// The terminal is opened once the remote's file system answers: activated by the resolution, the
// probe runs before the remote is there, and a terminal opened then is a local one. The shell's
// own pid goes into the file, so a second command says whether it ran in the same shell.
async function runInTerminal(folder) {
  await eventually(async () => {
    await vscode.workspace.fs.stat(folder)
    return true
  })
  const terminal = vscode.window.createTerminal({ name: "lane probe" })
  const write = async (event) => {
    const path = `/tmp/lane-probe-${process.pid}-${Date.now()}`
    terminal.sendText(`echo "$(hostname) $(id -un) $$ $PWD" > ${path}`)
    say(event, { path, output: await readBack(folder.with({ path })) })
  }
  await write("terminal")
  if (again) void whenAsked(again, () => write("again"))
}

// f's answer once it gives one, tried every second for ms; null if it never does.
async function eventually(f, ms = 300_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const answer = await f()
      if (answer !== undefined) return answer
    } catch {}
    await sleep(1_000)
  }
  return null
}

function readBack(file) {
  return eventually(async () => {
    const body = Buffer.from(await vscode.workspace.fs.readFile(file))
      .toString("utf8")
      .trim()
    return body === "" ? undefined : body
  }, READ_MS)
}

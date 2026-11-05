// What a vscode://spin-stack.spinbox/open link, or the command, names to open: a workspace and,
// optionally, an absolute path inside it.
export interface OpenTarget {
  workspace: string
  path?: string
}

export type Parsed = { target: OpenTarget } | { reason: string }

// A workspace is an id or a name, never a flag: the link is anyone's to write, and a value spin
// would read as an option (--endpoint=...) must not reach its command line.
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Control characters have no place in a path a link names, and a newline would split what spin
// writes into the SSH config.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters it refuses
const CONTROL = /[\u0000-\u001f\u007f]/

// checkTarget says why a workspace and path cannot be opened, or nothing when they can.
export function checkTarget(workspace: string, path: string | undefined): string | undefined {
  if (workspace === "") {
    return "the link names no workspace"
  }
  if (!WORKSPACE.test(workspace)) {
    return `"${workspace}" is not a workspace id or name`
  }
  if (path === undefined) {
    return undefined
  }
  if (!path.startsWith("/")) {
    return `the path "${path}" is not absolute`
  }
  if (CONTROL.test(path)) {
    return "the path holds a control character"
  }
  return undefined
}

// parseOpenUri reads a link's path and query, as vscode.Uri splits them: /open, workspace=<id>
// and, when it is there, path=<absolute path>.
export function parseOpenUri(uri: { path: string; query: string }): Parsed {
  if (uri.path !== "/open") {
    return { reason: `the link asks for "${uri.path}", which Spinbox does not answer` }
  }
  const query = new URLSearchParams(uri.query)
  const workspace = query.get("workspace") ?? ""
  const path = query.get("path") ?? undefined
  const reason = checkTarget(workspace, path)
  if (reason !== undefined) {
    return { reason }
  }
  return { target: path === undefined ? { workspace } : { workspace, path } }
}

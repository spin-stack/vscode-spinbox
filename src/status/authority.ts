// The Spinbox workspace a window is connected to, read from its remote authority: Remote-SSH's
// ssh-remote+spin.<workspace>, or spin+<workspace>, which Spinbox Remote resolves.
export interface SpinRemote {
  // The SSH host spin code wrote into the SSH config: spin.<workspace>.
  host: string
  // The workspace's name, or its id when its name is no SSH host (sshHost in spin's
  // cmd/cli/cmd/sshconfig.go).
  workspace: string
}

const PREFIX = "ssh-remote+"

// Spinbox Remote, the extension that resolves spin+<workspace> (src/remote/resolver.ts).
export const SPIN_RESOLVER = "spin-stack.spinbox-remote"

// The authority its src/spin/authority.ts resolves, a workspace by the same rule.
const SPIN_PREFIX = "spin+"

// hostSafeRe in spin's cmd/cli/cmd/sshconfig.go.
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// sshHostPrefix in spin's cmd/cli/cmd/sshconfig.go.
const HOST_PREFIX = "spin."

const FOLDER_PREFIX = `vscode-remote://${PREFIX}`

// Remote-SSH writes a host that is not all lower case as the hex of {"hostName": "<host>"}: a URI
// authority is compared without case.
const HEX = /^(?:[0-9a-f]{2})+$/

// parseSpinRemote answers the workspace a window is connected to, from vscode.env.remoteName and
// the authority of its folder's URI, or nothing when the window is not a Spinbox workspace.
export function parseSpinRemote(
  remoteName: string | undefined,
  authority: string | undefined,
): SpinRemote | undefined {
  if (remoteName === "spin" && authority?.startsWith(SPIN_PREFIX)) {
    const workspace = authority.slice(SPIN_PREFIX.length)
    return WORKSPACE.test(workspace) ? { host: HOST_PREFIX + workspace, workspace } : undefined
  }
  if (remoteName !== "ssh-remote" || authority === undefined || !authority.startsWith(PREFIX)) {
    return undefined
  }
  const host = decodeHost(authority.slice(PREFIX.length))
  const workspace = workspaceOf(host)
  return workspace === undefined ? undefined : { host, workspace }
}

// spinFolderUri answers the folder spin code names, vscode-remote://ssh-remote+spin.<workspace>
// <path>, as the same folder under spin+<workspace>, or nothing when it names another host.
export function spinFolderUri(folderUri: string): string | undefined {
  if (!folderUri.startsWith(FOLDER_PREFIX)) {
    return undefined
  }
  const rest = folderUri.slice(FOLDER_PREFIX.length)
  const slash = rest.indexOf("/")
  const workspace = workspaceOf(decodeHost(slash < 0 ? rest : rest.slice(0, slash)))
  if (workspace === undefined) {
    return undefined
  }
  return `vscode-remote://${SPIN_PREFIX}${workspace}${slash < 0 ? "/" : rest.slice(slash)}`
}

// workspaceOf answers the workspace of the SSH host spin.<workspace>, or nothing for another host.
function workspaceOf(host: string): string | undefined {
  if (!host.startsWith(HOST_PREFIX)) {
    return undefined
  }
  const workspace = host.slice(HOST_PREFIX.length)
  return WORKSPACE.test(workspace) ? workspace : undefined
}

function decodeHost(host: string): string {
  if (!HEX.test(host)) {
    return host
  }
  try {
    const v = JSON.parse(Buffer.from(host, "hex").toString("utf8")) as unknown
    if (typeof v === "object" && v !== null && "hostName" in v && typeof v.hostName === "string") {
      return v.hostName
    }
  } catch {
    // Not Remote-SSH's encoding: a host that only looks like hex.
  }
  return host
}

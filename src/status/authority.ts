// The Spinbox workspace a Remote-SSH window is connected to, read from its remote authority.
export interface SpinRemote {
  // The SSH host spin code wrote into the SSH config: spin.<workspace>.
  host: string
  // The workspace's name, or its id when its name is no SSH host (sshHost in spin's
  // cmd/cli/cmd/sshconfig.go).
  workspace: string
}

const PREFIX = "ssh-remote+"

// sshHostPrefix and hostSafeRe in spin's cmd/cli/cmd/sshconfig.go.
const HOST = /^spin\.([A-Za-z0-9][A-Za-z0-9_-]*)$/

// Remote-SSH writes a host that is not all lower case as the hex of {"hostName": "<host>"}: a URI
// authority is compared without case.
const HEX = /^(?:[0-9a-f]{2})+$/

// parseSpinRemote answers the workspace a window is connected to, from vscode.env.remoteName and
// the authority of its folder's URI (ssh-remote+spin.<workspace>), or nothing when the window is
// not a Spinbox workspace over Remote-SSH.
export function parseSpinRemote(
  remoteName: string | undefined,
  authority: string | undefined,
): SpinRemote | undefined {
  if (remoteName !== "ssh-remote" || authority === undefined || !authority.startsWith(PREFIX)) {
    return undefined
  }
  const host = decodeHost(authority.slice(PREFIX.length))
  const m = HOST.exec(host)
  return m?.[1] === undefined ? undefined : { host, workspace: m[1] }
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

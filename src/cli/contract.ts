// The contract between this extension and the spin CLI, spin-stack/spin#833: every command is run
// with `-o json`, a success is one JSON object on stdout with exit 0 (`spin login --no-browser`
// writes two lines), and a failure is one ErrorEnvelope on stdout with exit 1. These types are the
// whole of what the extension reads; a field the CLI adds is ignored until a type here names it.

// Each code, and the one action the CLI pairs with it. The CLI's list is cmd/cli/cmd/errcode.go.
export type ErrorCode =
  | "cli_outdated"
  | "not_signed_in"
  | "workspace_stopped"
  | "workspace_failed"
  | "access_needs_signature"
  | "no_capacity"
  | "unreachable"
  | "internal"

export type Action = "update" | "login" | "start" | "open_dashboard" | "sign" | "retry" | "details"

// The table in #833, as a type and as a value: a code missing from either fails typecheck.
export const ACTION_OF = {
  cli_outdated: "update",
  not_signed_in: "login",
  workspace_stopped: "start",
  workspace_failed: "open_dashboard",
  access_needs_signature: "sign",
  no_capacity: "retry",
  unreachable: "retry",
  internal: "details",
} as const satisfies Record<ErrorCode, Action>

export const ERROR_CODES = Object.keys(ACTION_OF) as ErrorCode[]

export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    action: Action
    message: string
    // The release the installation runs, with cli_outdated.
    release?: string
    workspace_id?: string
    // A page that resolves it: the signature page for access_needs_signature, the workspace's
    // dashboard page for workspace_failed.
    url?: string
  }
}

export interface User {
  id: string
  email: string
  name: string
}

// `spin version -o json`: exit 0 signed in or not. installation and user are there only when a
// call reached the installation; unreachable is the one failure it reports.
export interface VersionResult {
  cli: string
  profile: string
  endpoint: string
  signed_in: boolean
  installation?: string
  user?: User
}

// `spin login --no-browser -o json`, first line: written before it waits.
export interface LoginStart {
  verification_url: string
  user_code: string
  // Seconds.
  expires_in: number
}

// `spin login --no-browser -o json`, second line: the login completed.
export interface LoginDone {
  profile: string
  endpoint: string
  user: User
}

export type ServerSource = "carried" | "downloaded" | "missing"

// `spin code <workspace> [path] --no-open --vscode-commit <sha> -o json`: the SSH config is
// written and nothing is opened.
export interface CodeResult {
  workspace_id: string
  host: string
  // vscode-remote://ssh-remote+<host><path>
  folder_uri: string
  server: ServerSource
}

// `spin workspace list -o json` keeps the shape it has: {"items": [...]}, each item a
// spin.v1.Workspace as protojson with defaults emitted - lowerCamelCase names, enums by name,
// int64 as strings, timestamps as RFC 3339 strings, an unset message or timestamp absent.
export interface WorkspaceList {
  items: Workspace[]
}

export type WorkspaceState =
  | "WORKSPACE_STATE_UNSPECIFIED"
  | "WORKSPACE_STATE_CREATING"
  | "WORKSPACE_STATE_STARTING"
  | "WORKSPACE_STATE_RUNNING"
  | "WORKSPACE_STATE_STOPPING"
  | "WORKSPACE_STATE_STOPPED"
  | "WORKSPACE_STATE_FAILED"
  | "WORKSPACE_STATE_DELETED"
  | "WORKSPACE_STATE_WAITING"
  | "WORKSPACE_STATE_QUARANTINED"

export type WorkspaceFailure =
  | "WORKSPACE_FAILURE_UNSPECIFIED"
  | "WORKSPACE_FAILURE_VOLUME"
  | "WORKSPACE_FAILURE_EXTENSION"
  | "WORKSPACE_FAILURE_NETWORK"
  | "WORKSPACE_FAILURE_RESOURCES"
  | "WORKSPACE_FAILURE_MACHINE"
  | "WORKSPACE_FAILURE_GUEST"
  | "WORKSPACE_FAILURE_RELEASE_GONE"
  | "WORKSPACE_FAILURE_EXITED"
  | "WORKSPACE_FAILURE_STOP"
  | "WORKSPACE_FAILURE_TIMED_OUT"
  | "WORKSPACE_FAILURE_NO_HOST"
  | "WORKSPACE_FAILURE_MACHINE_CHANGED"

export type WorkspaceAction =
  | "WORKSPACE_ACTION_UNSPECIFIED"
  | "WORKSPACE_ACTION_START"
  | "WORKSPACE_ACTION_STOP"
  | "WORKSPACE_ACTION_FORCE_STOP"
  | "WORKSPACE_ACTION_DELETE"
  | "WORKSPACE_ACTION_FORCE_DELETE"
  | "WORKSPACE_ACTION_SUSPEND"
  | "WORKSPACE_ACTION_START_FROM_DISK"

export type WorkspacePhase =
  | "WORKSPACE_PHASE_UNSPECIFIED"
  | "WORKSPACE_PHASE_DISK"
  | "WORKSPACE_PHASE_EXTENSIONS"
  | "WORKSPACE_PHASE_NETWORK"
  | "WORKSPACE_PHASE_MACHINE"
  | "WORKSPACE_PHASE_FIRST_BOOT"
  | "WORKSPACE_PHASE_GUEST"
  | "WORKSPACE_PHASE_BACKUP"

// Only the two suspensions are ever in suspendsFor; the rest of WorkspaceEventType is the
// workspace's history, which a listing does not carry.
export type WorkspaceEventType =
  | "WORKSPACE_EVENT_TYPE_UNSPECIFIED"
  | "WORKSPACE_EVENT_TYPE_IDLE_SUSPENDED"
  | "WORKSPACE_EVENT_TYPE_RUNNING_CAP_SUSPENDED"

// RFC 3339, as protojson writes google.protobuf.Timestamp.
export type Timestamp = string

export interface Resources {
  cpuCores: number
  memoryMb: number
  diskGb: number
  maxCpuCores: number
  maxMemoryMb: number
  bandwidthMbps: number
}

export interface WorkspaceProgress {
  attempt: number
  attempts: number
  lastFailure: WorkspaceFailure
  lastReason: string
  phase: WorkspacePhase
  since?: Timestamp
  deadline?: Timestamp
}

export interface WorkspaceDurability {
  lastPublishedAt?: Timestamp
  // int64, a string in protojson.
  unpublishedSeconds: string
  unpublishedBytes: string
  stalled: boolean
  reportedAt?: Timestamp
}

export interface WorkspaceLease {
  name: string
  since?: Timestamp
  until?: Timestamp
}

// spin.v1.Workspace, api/proto/spin/v1/workspace.proto.
export interface Workspace {
  id: string
  name: string
  teamId: string
  hostId: string
  image: string
  resources?: Resources
  state: WorkspaceState
  url: string
  env: Record<string, string>
  createdAt?: Timestamp
  updatedAt?: Timestamp
  snapshotCount: number
  failureReason: string
  networkTags: string[]
  hostConnected: boolean
  waitingReason: string
  failure: WorkspaceFailure
  networkWatch: boolean
  floorCpuCores: number
  floorMemoryMb: number
  grantExpiresAt?: Timestamp
  quarantineHeld: boolean
  progress?: WorkspaceProgress
  allowedActions: WorkspaceAction[]
  failureSummary: string
  readyAt?: Timestamp
  traceId: string
  // Answered by GetWorkspace only: absent from a listing.
  durability?: WorkspaceDurability
  role: "owner" | "guest" | ""
  accessSigned: boolean
  memoryMachineGone: boolean
  suspendsAt?: Timestamp
  suspendsFor: WorkspaceEventType
  keptUntil?: Timestamp
  leases: WorkspaceLease[]
  projectId: string
  ref: string
  wakeOnAccess: boolean
  suspendedSnapshotId: string
  fromPrebuildId: string
  agentMinMemoryMb: number
  projectError: string
}

// Whether v is an error envelope: an object whose error names a code and an action of the
// contract. A code this extension does not know is not one - it is read as internal by whoever
// runs the command, never trusted to pick an action.
export function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  if (typeof v !== "object" || v === null || !("error" in v)) {
    return false
  }
  const e = (v as { error: unknown }).error
  if (typeof e !== "object" || e === null) {
    return false
  }
  const { code, action, message } = e as Record<string, unknown>
  return (
    typeof code === "string" &&
    Object.hasOwn(ACTION_OF, code) &&
    typeof action === "string" &&
    Object.values(ACTION_OF).includes(action as Action) &&
    typeof message === "string"
  )
}

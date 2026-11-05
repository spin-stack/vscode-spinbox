import type { Workspace } from "../cli/contract"

// What the view tells apart about a workspace. A suspended workspace is a stopped one that kept
// its memory (suspendedSnapshotId), which a start resumes; the API has no state of its own for it.
export type Shown =
  | "running"
  | "stopped"
  | "suspended"
  | "starting"
  | "stopping"
  | "failed"
  | "quarantined"
  | "unknown"

export function shownState(w: Workspace): Shown {
  switch (w.state) {
    case "WORKSPACE_STATE_RUNNING":
      return "running"
    case "WORKSPACE_STATE_STOPPED":
      return w.suspendedSnapshotId === "" ? "stopped" : "suspended"
    case "WORKSPACE_STATE_CREATING":
    case "WORKSPACE_STATE_STARTING":
    case "WORKSPACE_STATE_WAITING":
      return "starting"
    case "WORKSPACE_STATE_STOPPING":
      return "stopping"
    case "WORKSPACE_STATE_FAILED":
      return "failed"
    case "WORKSPACE_STATE_QUARANTINED":
      return "quarantined"
    default:
      return "unknown"
  }
}

// The codicon and theme color each one is drawn with.
export const ICON = {
  running: { id: "vm-running", color: "testing.iconPassed" },
  stopped: { id: "vm-outline" },
  suspended: { id: "debug-pause" },
  starting: { id: "loading~spin" },
  stopping: { id: "sync~spin" },
  failed: { id: "error", color: "testing.iconFailed" },
  quarantined: { id: "shield", color: "testing.iconFailed" },
  unknown: { id: "circle-outline" },
} as const satisfies Record<Shown, { id: string; color?: string }>

// The row's description: the state, and why when the CLI says why it waits or failed.
export function describe(w: Workspace): string {
  const shown = shownState(w)
  let why = ""
  if (shown === "failed") {
    why = w.failureSummary || w.failureReason
  } else if (w.state === "WORKSPACE_STATE_WAITING") {
    why = w.waitingReason
  }
  return why === "" ? shown : `${shown} - ${why}`
}

// The row's contextValue: what package.json's menus offer on it. start and stop are offered when
// the workspace's allowedActions name them, so a menu never offers what the API would refuse.
export function contextValue(w: Workspace): string {
  const flags = ["workspace"]
  if (w.allowedActions.includes("WORKSPACE_ACTION_START")) {
    flags.push("startable")
  }
  if (w.allowedActions.includes("WORKSPACE_ACTION_STOP")) {
    flags.push("stoppable")
  }
  return flags.join(" ")
}

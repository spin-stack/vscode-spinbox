import { randomBytes } from "node:crypto"

// A Trace hands out the W3C traceparent of a new trace for one operation, which the spin CLI joins
// with --traceparent and exports its spans under; the extension exports no spans of its own.
// undefined means telemetry is off and the CLI is handed none.
export type Trace = () => string | undefined

// tracer starts a trace per call while enabled answers true, read at each call so a change of the
// setting holds from the next operation on.
export function tracer(enabled: () => boolean): Trace {
  return () => (enabled() ? newTraceparent() : undefined)
}

// newTraceparent is version 00, a random trace-id and parent-id, sampled. The spec reserves an
// id of all zeros as invalid, so one is drawn again.
export function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

// traceIdOf is the trace-id of a traceparent, the id Admin -> Traces finds the operation by.
export function traceIdOf(traceparent: string | undefined): string | undefined {
  return traceparent === undefined ? undefined : TRACEPARENT.exec(traceparent)?.[1]
}

function randomHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex")
    if (!/^0+$/.test(hex)) {
      return hex
    }
  }
}

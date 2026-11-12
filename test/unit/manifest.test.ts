import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { COMMANDS } from "../../src/commands"

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

describe("package.json", () => {
  it("contributes the commands the extension registers, and activates on each", () => {
    const contributed = manifest.contributes.commands.map((c: { command: string }) => c.command)
    expect(contributed).toEqual([...COMMANDS])
    for (const id of COMMANDS) {
      expect(manifest.activationEvents).toContain(`onCommand:${id}`)
    }
  })

  // VS Code waits for this activation before Remote-SSH resolves (src/remote/connect.ts).
  it("activates when a window resolves over Remote-SSH", () => {
    expect(manifest.activationEvents).toContain("onResolveRemoteAuthority:ssh-remote")
  })
})

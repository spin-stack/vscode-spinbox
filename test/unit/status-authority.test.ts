import { describe, expect, it } from "vitest"
import { parseSpinRemote } from "../../src/status/authority"

const hex = (host: string) => Buffer.from(JSON.stringify({ hostName: host })).toString("hex")

describe("parseSpinRemote", () => {
  it("reads the workspace from a Remote-SSH authority spin.<workspace>", () => {
    expect(parseSpinRemote("ssh-remote", "ssh-remote+spin.my-ws")).toEqual({
      host: "spin.my-ws",
      workspace: "my-ws",
    })
  })

  it("reads a host Remote-SSH wrote as hex", () => {
    expect(parseSpinRemote("ssh-remote", `ssh-remote+${hex("spin.My_WS")}`)).toEqual({
      host: "spin.My_WS",
      workspace: "My_WS",
    })
  })

  it.each([
    ["another remote", "wsl", "ssh-remote+spin.my-ws"],
    ["a local window", undefined, undefined],
    ["no folder", "ssh-remote", undefined],
    ["another host", "ssh-remote", "ssh-remote+devbox"],
    ["a host under spin's", "ssh-remote", "ssh-remote+spin.my-ws.example.com"],
    ["no workspace", "ssh-remote", "ssh-remote+spin."],
    ["a flag", "ssh-remote", "ssh-remote+spin.-oProxyCommand"],
    ["hex of another host", "ssh-remote", `ssh-remote+${hex("devbox")}`],
    ["another remote's authority", "ssh-remote", "wsl+spin.my-ws"],
  ])("is nothing for %s", (_what, remoteName, authority) => {
    expect(parseSpinRemote(remoteName, authority)).toBeUndefined()
  })
})

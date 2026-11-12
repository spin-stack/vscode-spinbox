import { describe, expect, it } from "vitest"
import { parseSpinRemote, spinFolderUri } from "../../src/status/authority"

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

  it("reads the workspace from the resolver's authority spin+<workspace>", () => {
    expect(parseSpinRemote("spin", "spin+My_WS")).toEqual({
      host: "spin.My_WS",
      workspace: "My_WS",
    })
  })

  it.each([
    ["a resolver's workspace that is a flag", "spin", "spin+-oProxyCommand"],
    ["a resolver's authority with no workspace", "spin", "spin+"],
    ["a resolver's workspace with a dot", "spin", "spin+my-ws.example.com"],
    ["the resolver's authority under Remote-SSH", "ssh-remote", "spin+my-ws"],
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

describe("spinFolderUri", () => {
  it.each([
    ["vscode-remote://ssh-remote+spin.my-ws/root/src", "vscode-remote://spin+my-ws/root/src"],
    [`vscode-remote://ssh-remote+${hex("spin.My_WS")}/root`, "vscode-remote://spin+My_WS/root"],
    ["vscode-remote://ssh-remote+spin.my-ws", "vscode-remote://spin+my-ws/"],
  ])("opens %s as %s", (folder, want) => {
    expect(spinFolderUri(folder)).toBe(want)
  })

  it.each([
    ["another host", "vscode-remote://ssh-remote+devbox/root"],
    ["a host under spin's", "vscode-remote://ssh-remote+spin.my-ws.example.com/root"],
    ["a flag", "vscode-remote://ssh-remote+spin.-oProxyCommand/root"],
    ["another remote", "vscode-remote://wsl+spin.my-ws/root"],
    ["a local folder", "file:///root"],
  ])("is nothing for %s", (_what, folder) => {
    expect(spinFolderUri(folder)).toBeUndefined()
  })
})

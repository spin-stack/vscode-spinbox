import { describe, expect, it } from "vitest"
import { parseOpenUri } from "../../src/open/target"

describe("parseOpenUri", () => {
  it.each([
    ["workspace=ws-1&path=/root", { workspace: "ws-1", path: "/root" }],
    ["workspace=my.ws_2&path=%2Fhome%2Fdev%2Fsrc", { workspace: "my.ws_2", path: "/home/dev/src" }],
    ["workspace=ws-1", { workspace: "ws-1" }],
  ])("opens %s", (query, target) => {
    expect(parseOpenUri({ path: "/open", query })).toEqual({ target })
  })

  it.each([
    ["/open", "", "the link names no workspace"],
    ["/open", "workspace=&path=/root", "the link names no workspace"],
    ["/open", "workspace=--endpoint%3Dhttps%3A%2F%2Fevil&path=/root", "is not a workspace id"],
    ["/open", "workspace=-x", "is not a workspace id"],
    ["/open", "workspace=a%20b", "is not a workspace id"],
    ["/open", "workspace=ws-1&path=root", 'the path "root" is not absolute'],
    ["/open", "workspace=ws-1&path=", 'the path "" is not absolute'],
    ["/open", "workspace=ws-1&path=%2Froot%0AHost%20x", "control character"],
    ["/other", "workspace=ws-1&path=/root", "which Spinbox does not answer"],
  ])("refuses %s?%s", (path, query, reason) => {
    const r = parseOpenUri({ path, query })
    expect(r).toEqual({ reason: expect.stringContaining(reason) })
  })
})

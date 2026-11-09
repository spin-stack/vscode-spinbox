import { describe, expect, it } from "vitest"
import { documents, JsonDocuments } from "../../src/cli/documents"

const indented = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const line = (v: unknown) => `${JSON.stringify(v)}\n`

describe("documents", () => {
  it.each([
    ["one indented document", indented({ a: 1, b: { c: [1, 2] } }), [{ a: 1, b: { c: [1, 2] } }]],
    ["JSON Lines", line({ a: 1 }) + line({ b: 2 }), [{ a: 1 }, { b: 2 }]],
    [
      "JSON Lines, then an indented envelope",
      line({ a: 1 }) + indented({ error: { code: "x" } }),
      [{ a: 1 }, { error: { code: "x" } }],
    ],
    ["documents with nothing between them", '{"a":1}{"b":2}[3]', [{ a: 1 }, { b: 2 }, [3]]],
    ["brackets and quotes inside strings", indented({ s: '}{]["\\' }), [{ s: '}{]["\\' }]],
    ["an empty output", "", []],
    ["whitespace alone", "\n  \n", []],
    ["a line that is not a document", `panic: boom\n${line({ a: 1 })}`, [undefined, { a: 1 }]],
    ["a document cut short", '{"a": [1,', [undefined]],
    ["text cut short", "panic", [undefined]],
  ])("%s", (_, text, want) => {
    expect(documents(text)).toEqual(want)
  })
})

describe("JsonDocuments", () => {
  it("hands out each document once its last bracket arrives, however the text is cut", () => {
    const text = line({ verification_url: "u", user_code: "c" }) + indented({ profile: "p" })
    for (let size = 1; size <= text.length; size++) {
      const d = new JsonDocuments()
      const seen: unknown[][] = []
      for (let i = 0; i < text.length; i += size) {
        seen.push(d.push(text.slice(i, i + size)))
      }
      expect(seen.flat().concat(d.end())).toEqual([
        { verification_url: "u", user_code: "c" },
        { profile: "p" },
      ])
      // The first document is out by the chunk that holds its closing bracket, before the second.
      const first = seen.findIndex((s) => s.length > 0)
      expect(first).toBe(Math.floor(text.indexOf("}") / size))
    }
  })
})

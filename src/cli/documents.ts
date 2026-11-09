// JsonDocuments splits what spin writes on stdout into its JSON documents as the text arrives.
// spin writes a document indented over many lines (spin's cmd/cli/cmd/output.go, emit) and the
// documents of a command that answers more than one each on a line of its own (emitLine: login,
// and an envelope after it), so neither a line nor the whole output is a document: one ends
// where the brackets it opened close, whatever whitespace lies inside or between.
//
// Each document is handed out parsed as soon as its last bracket arrives, so a caller acts on
// login's first one while spin still waits. Text outside a document, which the contract does
// not allow, is handed out a line at a time as what it parses to: undefined unless it is JSON.
export class JsonDocuments {
  private text = ""
  // Where the scan of text has got to, so a document arriving in many chunks is scanned once.
  private scanned = 0
  private depth = 0
  private inString = false
  private escaped = false

  // The documents chunk completes, in order.
  push(chunk: string): unknown[] {
    this.text += chunk
    const out: unknown[] = []
    while (this.scanned < this.text.length) {
      if (this.depth === 0 && !this.leading(out)) {
        break
      }
      const end = this.close()
      if (end < 0) {
        break
      }
      out.push(parse(this.text.slice(0, end)))
      this.take(end)
    }
    return out
  }

  // Whatever is left once the output has ended: a document cut short, as undefined.
  end(): unknown[] {
    const rest = this.text.trim()
    this.take(this.text.length)
    this.depth = 0
    this.inString = false
    this.escaped = false
    return rest === "" ? [] : [parse(rest)]
  }

  // Between documents: drops whitespace, hands out a line of text that is not a document, and
  // says whether a document begins at the start of text.
  private leading(out: unknown[]): boolean {
    for (;;) {
      const start = this.text.search(/\S/)
      if (start < 0) {
        this.take(this.text.length)
        return false
      }
      this.take(start)
      const c = this.text[0]
      if (c === "{" || c === "[") {
        return true
      }
      const nl = this.text.indexOf("\n")
      if (nl < 0) {
        return false
      }
      out.push(parse(this.text.slice(0, nl)))
      this.take(nl + 1)
    }
  }

  // The index just past the bracket that closes the document text begins with, or -1 when it
  // has not arrived yet.
  private close(): number {
    for (; this.scanned < this.text.length; this.scanned++) {
      const c = this.text[this.scanned]
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false
        } else if (c === "\\") {
          this.escaped = true
        } else if (c === '"') {
          this.inString = false
        }
      } else if (c === '"') {
        this.inString = true
      } else if (c === "{" || c === "[") {
        this.depth++
      } else if (c === "}" || c === "]") {
        this.depth--
        if (this.depth === 0) {
          return ++this.scanned
        }
      }
    }
    return -1
  }

  private take(n: number): void {
    this.text = this.text.slice(n)
    this.scanned = Math.max(0, this.scanned - n)
  }
}

// All of text's documents at once: what JsonDocuments hands out over a whole output.
export function documents(text: string): unknown[] {
  const d = new JsonDocuments()
  return [...d.push(text), ...d.end()]
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

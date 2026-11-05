import { readFile } from "node:fs/promises"
import { join } from "node:path"

const COMMIT = /^[0-9a-f]{40}$/

// readCommit answers the commit of the VS Code that runs the extension, from product.json in its
// appRoot: the server spin attaches to the workspace has to be that commit's.
export async function readCommit(appRoot: string): Promise<string> {
  const product = JSON.parse(await readFile(join(appRoot, "product.json"), "utf8")) as {
    commit?: unknown
  }
  if (typeof product.commit !== "string" || !COMMIT.test(product.commit)) {
    throw new Error("this VS Code build names no commit in its product.json, so no server matches")
  }
  return product.commit
}

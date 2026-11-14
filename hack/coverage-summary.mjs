// The unit tests' coverage, from what `vitest run --coverage` writes into coverage/, as the job's
// summary (stdout outside a workflow). The HTML beside it is the coverage-web artifact.
import { appendFileSync, existsSync, readFileSync } from "node:fs"

const file = "coverage/coverage-summary.json"
const write = (text) => {
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `${text}\n`)
  else console.log(text)
}

if (!existsSync(file)) {
  write(`${file} was not produced; the tests may have failed before coverage ran.`)
} else {
  const { total } = JSON.parse(readFileSync(file, "utf8"))
  const rows = ["statements", "branches", "functions", "lines"].map((key) => {
    const { covered, total: all, pct } = total[key]
    return `| ${key} | ${covered} | ${all} | ${pct}% |`
  })
  write(
    [
      "## Unit test coverage",
      "",
      "| Metric | Covered | Total | % |",
      "|---|---:|---:|---:|",
      ...rows,
    ].join("\n"),
  )
}

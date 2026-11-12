import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SCRIPTS = ["typecheck", "lint", "test"] as const

export interface InitOptions {
  /** Adds the merge job and a `tug.json` that merges low-risk pull requests by itself. */
  merge: boolean
  /** Runner labels, such as ["self-hosted", "tug"]. */
  runsOn: string[]
}

export interface InitResult {
  files: { path: string; content: string }[]
  notes: string[]
}

/** The test steps for a repository's root `package.json`, from its lockfile and scripts, or none. */
function testSteps(dir: string): string[] | null {
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return null
  const scripts = (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}
  const run = SCRIPTS.filter((name) => scripts[name])
  if (run.length === 0) return null
  const node = ["      - uses: actions/setup-node@v5", "        with:", "          node-version: 24"]
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")))
    return [...node, "      - uses: oven-sh/setup-bun@v2", "      - run: bun install --frozen-lockfile", ...run.map((name) => `      - run: bun run ${name}`)]
  if (existsSync(join(dir, "pnpm-lock.yaml")))
    return [...node, "      - run: corepack enable", "      - run: pnpm install --frozen-lockfile", ...run.map((name) => `      - run: pnpm run ${name}`)]
  if (existsSync(join(dir, "yarn.lock")))
    return [...node, "      - run: corepack enable", "      - run: yarn install --immutable", ...run.map((name) => `      - run: yarn run ${name}`)]
  return [...node, `      - run: ${existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install"}`, ...run.map((name) => `      - run: npm run ${name}`)]
}

/**
 * The files that add Tug to the repository in `dir`: `.github/workflows/tug.yml` with its tests, review and, with
 * `merge`, the merge job, plus `tug.json`. Merge waits for every check of the head, so it only works when the tests
 * run in this same workflow; a repository with CI of its own gets the review and a note.
 */
export function init(dir: string, options: InitOptions): InitResult {
  const notes: string[] = []
  const workflows = join(dir, ".github", "workflows")
  const others = existsSync(workflows) ? readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name) && name !== "tug.yml") : []
  const runsOn = JSON.stringify(options.runsOn)
  const steps = others.length > 0 ? null : testSteps(dir)
  let merge = options.merge
  if (merge && others.length > 0) {
    merge = false
    notes.push(`${others.join(", ")} already runs CI. Tug's merge waits for every check, and checks from another workflow look pending, so add the review and merge jobs to that workflow instead; tug.yml only reviews.`)
  }
  if (!steps && others.length === 0) notes.push("No package.json scripts (typecheck, lint, test) were found, so tug.yml has no test job.")

  const lines = [
    "name: tug",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened, ready_for_review]",
    "concurrency:",
    "  group: tug-${{ github.event.pull_request.number }}",
    "  cancel-in-progress: true",
    "permissions:",
    "  contents: read",
    "jobs:",
  ]
  if (steps) lines.push("  test:", `    runs-on: ${runsOn}`, "    timeout-minutes: 20", "    steps:", "      - uses: actions/checkout@v5", ...steps)
  lines.push(
    "  review:",
    "    uses: hellogafaro/tug/.github/workflows/review.yml@main",
    "    with:",
    `      runs-on: '${runsOn}'`,
    "    secrets: inherit",
    "    permissions:",
    "      contents: read",
    "      pull-requests: write",
    "      issues: write",
    "      id-token: write",
  )
  if (merge)
    lines.push(
      "  merge:",
      `    needs: [${steps ? "test, " : ""}review]`,
      "    uses: hellogafaro/tug/.github/workflows/merge.yml@main",
      "    with:",
      `      runs-on: '${runsOn}'`,
      "      review: ${{ needs.review.outputs.review }}",
      "    permissions:",
      "      checks: read",
      "      statuses: read",
      "      contents: write",
      "      pull-requests: write",
      "      issues: write",
    )
  const files = [{ path: ".github/workflows/tug.yml", content: `${lines.join("\n")}\n` }]
  if (merge) files.push({ path: "tug.json", content: `${JSON.stringify({ merge: { risk: "low" } }, null, 2)}\n` })
  return { files, notes }
}

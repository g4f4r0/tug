import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SCRIPTS = ["typecheck", "lint", "test"] as const
/** Whether a runs-on label names one of GitHub's own runners, such as ubuntu-latest; any other names Tug's own. */
const githubHosted = (label: string): boolean => /^(ubuntu|windows|macos)-/u.test(label)

/** The model settings review.yml takes. */
const SECRETS = ["TUG_OPENAI_API_KEY", "TUG_OPENAI_BASE_URL", "TUG_ANTHROPIC_API_KEY", "TUG_ANTHROPIC_BASE_URL", "TUG_REVIEW_MODEL", "TUG_REVIEW_REASONING_EFFORT", "TUG_SECURITY_MODEL", "TUG_SECURITY_REASONING_EFFORT"]

interface InitOptions {
  /** Adds the merge job and a `tug.json` that merges low-risk pull requests by itself. */
  merge: boolean
  /** Runner labels, such as ["tug"]. */
  runsOn: string[]
}

interface InitResult {
  files: { path: string; content: string }[]
  notes: string[]
}

/**
 * Installs the repository's pnpm: its `packageManager` through Corepack, else the newest major that writes its
 * lockfile's version. Corepack alone would take the newest pnpm, which may refuse a lockfile or settings an older one
 * wrote.
 */
function pnpmSetup(dir: string, packageManager: string | undefined): string {
  if (packageManager?.startsWith("pnpm@")) return "corepack enable"
  const lockfile = /^lockfileVersion: '?(\d+)/mu.exec(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"))?.[1]
  const major = { "5": 7, "6": 8, "9": 10 }[lockfile ?? ""] ?? 10
  return `npm install --global pnpm@${major}`
}

/** The test job's name and steps for a repository's root `package.json`, from its lockfile and scripts, or none. */
function testSteps(dir: string): { name: string; steps: string[] } | null {
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return null
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string>; packageManager?: string }
  const scripts = pkg.scripts ?? {}
  const run = SCRIPTS.filter((name) => scripts[name])
  if (run.length === 0) return null
  const name = `test / ${run.join(", ")}`
  const steps = (install: string[], runner: string) => ({ name, steps: [...install, ...run.map((script) => `      - run: ${runner} ${script}`)] })
  // No package manager cache: setup-node would need the package manager installed first, and runners are single-use.
  const node = ["      - uses: actions/setup-node@v5", "        with:", "          node-version: 24", "          package-manager-cache: false"]
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")))
    return steps([...node, "      - uses: oven-sh/setup-bun@v2", "      - run: bun install --frozen-lockfile"], "bun run")
  if (existsSync(join(dir, "pnpm-lock.yaml")))
    return steps([...node, `      - run: ${pnpmSetup(dir, pkg.packageManager)}`, "      - run: pnpm install --frozen-lockfile"], "pnpm run")
  if (existsSync(join(dir, "yarn.lock")))
    return steps([...node, "      - run: corepack enable", "      - run: yarn install --immutable"], "yarn run")
  return steps([...node, `      - run: ${existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install"}`], "npm run")
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
  const test = others.length > 0 ? null : testSteps(dir)
  let merge = options.merge
  if (merge && others.length > 0) {
    merge = false
    notes.push(`${others.join(", ")} already runs CI. Tug's merge waits for every check, and checks from another workflow look pending, so add the review and merge jobs to that workflow instead; tug.yml only reviews.`)
  }
  if (!test && others.length === 0) notes.push("No package.json scripts (typecheck, lint, test) were found, so tug.yml has no test job.")

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
  if (test) lines.push("  test:", `    name: ${test.name}`, `    runs-on: ${runsOn}`, "    timeout-minutes: 20", "    steps:", "      - uses: actions/checkout@v5", ...test.steps)
  lines.push(
    "  review:",
    "    uses: g4f4r0/tug/.github/workflows/review.yml@main",
    "    with:",
    `      runs-on: '${runsOn}'`,
    // On GitHub's runners, Tug's own secrets, never all of them. On Tug's own runners, none: their key service holds
    // the model keys, and a secret passed here would reach every job's container.
    ...(options.runsOn.every(githubHosted) ? ["    secrets:", ...SECRETS.map((name) => `      ${name}: \${{ secrets.${name} }}`)] : []),
    "    permissions:",
    "      contents: read",
    "      pull-requests: write",
    "      issues: write",
    "      id-token: write",
  )
  if (merge)
    lines.push(
      "  merge:",
      `    needs: [${test ? "test, " : ""}review]`,
      "    uses: g4f4r0/tug/.github/workflows/merge.yml@main",
      "    with:",
      `      runs-on: '${runsOn}'`,
      "      review: ${{ needs.review.outputs.review }}",
      "    permissions:",
      "      actions: read",
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

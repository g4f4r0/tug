import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { init } from "../src/init.ts"

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tug-init-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}
const scripts = (names: string[]) => JSON.stringify({ scripts: Object.fromEntries(names.map((name) => [name, "x"])) })
const tug = (dir: string, merge = true) => init(dir, { merge, runsOn: ["tug"] })

describe("tug init", () => {
  it("tests with the repository's package manager and scripts, then reviews and merges", () => {
    const { files, notes } = tug(repo({ "package.json": scripts(["test", "typecheck", "build"]), "pnpm-lock.yaml": "" }))
    const workflow = files[0]!.content
    expect(files.map((file) => file.path)).toEqual([".github/workflows/tug.yml", "tug.json"])
    expect(workflow).toContain("      - run: pnpm install --frozen-lockfile\n      - run: pnpm run typecheck\n      - run: pnpm run test\n")
    expect(workflow).not.toContain("build")
    expect(workflow).toContain("  test:\n    name: test / typecheck, test\n")
    expect(workflow).toContain(`    runs-on: ["tug"]`)
    expect(workflow).toContain("    needs: [test, review]")
    expect(workflow).toContain("      review: ${{ needs.review.outputs.review }}")
    expect(workflow).toContain("          package-manager-cache: false\n")
    expect(workflow).toContain("    secrets:\n      TUG_OPENAI_API_KEY: ${{ secrets.TUG_OPENAI_API_KEY }}\n      TUG_OPENAI_BASE_URL: ${{ secrets.TUG_OPENAI_BASE_URL }}\n      TUG_ANTHROPIC_API_KEY: ${{ secrets.TUG_ANTHROPIC_API_KEY }}\n      TUG_ANTHROPIC_BASE_URL: ${{ secrets.TUG_ANTHROPIC_BASE_URL }}\n      TUG_REVIEW_MODEL: ${{ secrets.TUG_REVIEW_MODEL }}\n      TUG_REVIEW_REASONING_EFFORT: ${{ secrets.TUG_REVIEW_REASONING_EFFORT }}\n      TUG_SECURITY_MODEL: ${{ secrets.TUG_SECURITY_MODEL }}\n      TUG_SECURITY_REASONING_EFFORT: ${{ secrets.TUG_SECURITY_REASONING_EFFORT }}\n    permissions:")
    expect(workflow).not.toContain("TUG_MODEL_")
    expect(workflow).not.toContain("inherit")
    expect(JSON.parse(files[1]!.content)).toEqual({ merge: { risk: "low" } })
    expect(notes).toEqual([])
  })

  it("uses bun or npm from the lockfile", () => {
    expect(tug(repo({ "package.json": scripts(["lint"]), "bun.lock": "" })).files[0]!.content).toContain("      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n      - run: bun run lint\n")
    expect(tug(repo({ "package.json": scripts(["test"]), "package-lock.json": "" })).files[0]!.content).toContain("      - run: npm ci\n      - run: npm run test\n")
  })

  it("installs the repository's pnpm, not the newest", () => {
    const pinned = JSON.stringify({ scripts: { lint: "x" }, packageManager: "pnpm@10.17.1" })
    expect(tug(repo({ "package.json": pinned, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })).files[0]!.content).toContain("      - run: corepack enable\n      - run: pnpm install")
    expect(tug(repo({ "package.json": scripts(["lint"]), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })).files[0]!.content).toContain("      - run: npm install --global pnpm@10\n      - run: pnpm install")
    expect(tug(repo({ "package.json": scripts(["lint"]), "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" })).files[0]!.content).toContain("      - run: npm install --global pnpm@8\n")
  })

  it("only reviews without merge, or without tests to wait for", () => {
    const theme = tug(repo({ "layout/theme.liquid": "" }), false)
    expect(theme.files.map((file) => file.path)).toEqual([".github/workflows/tug.yml"])
    expect(theme.files[0]!.content).not.toContain("  test:")
    expect(theme.files[0]!.content).not.toContain("  merge:")
    expect(tug(repo({ "layout/theme.liquid": "" })).files[0]!.content).toContain("    needs: [review]")
  })

  it("leaves a repository's own CI alone and doesn't merge beside it", () => {
    const { files, notes } = tug(repo({ "package.json": scripts(["test"]), ".github/workflows/ci.yml": "" }))
    expect(files.map((file) => file.path)).toEqual([".github/workflows/tug.yml"])
    expect(files[0]!.content).not.toContain("  test:")
    expect(files[0]!.content).not.toContain("  merge:")
    expect(notes[0]).toContain("ci.yml already runs CI")
  })
})

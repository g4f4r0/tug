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
const tug = (dir: string, merge = true) => init(dir, { merge, runsOn: ["self-hosted", "tug"] })

describe("tug init", () => {
  it("tests with the repository's package manager and scripts, then reviews and merges", () => {
    const { files, notes } = tug(repo({ "package.json": scripts(["test", "typecheck", "build"]), "pnpm-lock.yaml": "" }))
    const workflow = files[0]!.content
    expect(files.map((file) => file.path)).toEqual([".github/workflows/tug.yml", "tug.json"])
    expect(workflow).toContain("      - run: pnpm install --frozen-lockfile\n      - run: pnpm run typecheck\n      - run: pnpm run test\n")
    expect(workflow).not.toContain("build")
    expect(workflow).toContain("  test:\n    name: test / typecheck, test\n")
    expect(workflow).toContain(`    runs-on: ["self-hosted","tug"]`)
    expect(workflow).toContain("    needs: [test, review]")
    expect(workflow).toContain("      review: ${{ needs.review.outputs.review }}")
    expect(JSON.parse(files[1]!.content)).toEqual({ merge: { risk: "low" } })
    expect(notes).toEqual([])
  })

  it("uses bun or npm from the lockfile", () => {
    expect(tug(repo({ "package.json": scripts(["lint"]), "bun.lock": "" })).files[0]!.content).toContain("      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n      - run: bun run lint\n")
    expect(tug(repo({ "package.json": scripts(["test"]), "package-lock.json": "" })).files[0]!.content).toContain("      - run: npm ci\n      - run: npm run test\n")
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

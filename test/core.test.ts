import { describe, expect, it } from "vitest"
import { parsePolicy, PullState, Review, type Policy } from "../src/contracts.ts"
import { decide } from "../src/core/decide.ts"
import { passes } from "../src/core/filters.ts"
import { describeState, state, type PullFacts } from "../src/core/state.ts"

const HEAD = "a".repeat(40)

const facts = (overrides: Partial<PullFacts> = {}): PullFacts => ({
  repo: "g4f4r0/opencode-plugins",
  number: 12,
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeableState: "clean",
  head: HEAD,
  base: "main",
  title: "docs: Fix a typo",
  author: "g4f4r0",
  labels: [],
  checks: [{ name: "test", status: "completed", conclusion: "success" }],
  statuses: [],
  threads: 0,
  ...overrides,
})

describe("state", () => {
  it("returns a valid PullState contract", () => {
    expect(PullState.parse(state(facts()))).toMatchObject({ state: "READY" })
  })

  it("fails closed when an open pull request's checks were not read", () => {
    expect(() => state(facts({ checks: undefined }))).toThrow("were not read")
  })

  it("counts every failed conclusion, and success, neutral and skipped as passed", () => {
    const conclusions = ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale", null]
    const read = state(facts({ checks: [...conclusions.map((conclusion, index) => ({ name: `c${index}`, status: "completed", conclusion })), ...["success", "neutral", "skipped"].map((conclusion) => ({ name: conclusion, status: "completed", conclusion }))] }))
    expect(read.failed).toEqual(conclusions.map((_, index) => `c${index}`))
  })

  it("describes what holds a head", () => {
    expect(describeState(state(facts({ threads: 1, checks: [{ name: "lint", status: "queued", conclusion: null }] })))).toBe("THREADS · pending: lint · 1 unresolved thread")
  })
})

describe("filters", () => {
  it("match like GitHub Actions: last match wins, and only negations start from everything", () => {
    expect(passes(undefined, "x")).toBe(true)
    expect(passes(["!master"], "main")).toBe(true)
    expect(passes(["!master"], "master")).toBe(false)
    expect(passes(["release/**", "!release/old"], "release/new/x")).toBe(true)
    expect(passes(["release/**", "!release/old"], "release/old")).toBe(false)
    expect(passes(["!release/old", "release/**"], "release/old")).toBe(true)
    expect(passes(["main"], "feature")).toBe(false)
  })

  it("keep * inside a segment, ** across segments, and brackets literal", () => {
    expect(passes(["!locales/**"], "locales/en/x.json")).toBe(false)
    expect(passes(["!locales/**"], "src/locales/x.json")).toBe(true)
    expect(passes(["docs/*.md"], "docs/a.md")).toBe(true)
    expect(passes(["docs/*.md"], "docs/sub/a.md")).toBe(false)
    expect(passes(["**/*.md"], "a.md")).toBe(true)
    expect(passes(["dependabot[bot]"], "dependabot[bot]")).toBe(true)
    expect(passes(["dependabot[bot]"], "dependabotb")).toBe(false)
    expect(passes(["G4F4R0"], "g4f4r0", { caseless: true })).toBe(true)
  })

  it("match file names with newlines, so an excluded directory can't be escaped", () => {
    expect(passes(["!locales/**"], "locales/a\nb.json")).toBe(false)
    expect(passes(["!locales/**"], "locales/a\n/b.json")).toBe(false)
    expect(passes(["!**/secret"], "a\nb/secret")).toBe(false)
    expect(passes(["!docs/?"], "docs/\n")).toBe(false)
  })
})

describe("policy", () => {
  it("is empty without a file, and rejects unknown keys so a typo never drops a filter", () => {
    expect(parsePolicy(null)).toEqual({})
    expect(() => parsePolicy(JSON.stringify({ merge: { risk: "low", filter: { paths: ["!x"] } } }))).toThrow()
    expect(() => parsePolicy("{")).toThrow()
    expect(parsePolicy(JSON.stringify({ $schema: "s", merge: { risk: "low", filters: { authors: ["g4f4r0"] } }, rules: ["r"] })).merge?.risk).toBe("low")
  })
})

describe("decide", () => {
  const POLICY: Policy = { merge: { risk: "low", filters: { authors: ["g4f4r0"], branches: ["!master"], paths: ["!config/settings_data.json", "!locales/**"] } } }
  const review = (overrides: Partial<Review> = {}): Review => Review.parse({ version: 1, head: HEAD, findings: [], risk: "low", merge: true, reason: "Docs only.", ...overrides })
  const run = (overrides: { facts?: Partial<PullFacts>; review?: Review | null; policy?: Policy; files?: string[] } = {}) =>
    decide({ state: state(facts(overrides.facts)), review: overrides.review === undefined ? review() : overrides.review, policy: overrides.policy ?? POLICY, files: overrides.files ?? ["README.md"] })

  it("merges a ready head that every filter passes, with a low-risk review of that head that says merge", () => {
    expect(run()).toEqual({ action: "merge", reason: "Docs only." })
  })

  it("only reviews when tug.json has no merge", () => {
    expect(run({ policy: {} })).toMatchObject({ action: "wait" })
    expect(run({ policy: { rules: ["x"] } })).toMatchObject({ action: "wait" })
  })

  it("waits, changing nothing, until the head is ready", () => {
    for (const overrides of [{ threads: 1 }, { mergeable: false }, { draft: true }, { labels: ["merge:hold"] }, { labels: ["needs:human"] }, { merged: true }, { checks: [{ name: "t", status: "completed", conclusion: "failure" }] }])
      expect(run({ facts: overrides }).action).toBe("wait")
  })

  it("holds when a filter fails, checking every changed file", () => {
    expect(run({ facts: { author: "someone" } })).toMatchObject({ action: "hold", reason: "The author someone is not in merge.filters.authors." })
    expect(run({ facts: { base: "master" } }).action).toBe("hold")
    expect(run({ files: ["README.md", "locales/en.json"] })).toMatchObject({ action: "hold", reason: "locales/en.json not in merge.filters.paths." })
    expect(run({ files: [] }).action).toBe("hold")
    expect(run({ files: ["README.md", ".github/workflows/x.yml"] })).toMatchObject({ action: "hold", reason: ".github/workflows/x.yml changes the repository's GitHub configuration." })
  })

  it("holds without a review of this head", () => {
    expect(run({ review: null }).action).toBe("hold")
    expect(run({ review: review({ head: "b".repeat(40) }) }).action).toBe("hold")
  })

  it("holds above the policy's risk, on a critical or high finding, and when the review says not to merge", () => {
    expect(run({ review: review({ risk: "medium" }) })).toMatchObject({ action: "hold", reason: "Risk is medium; tug.json merges up to low." })
    expect(run({ review: review({ risk: "medium" }), policy: { merge: { risk: "medium" } } }).action).toBe("merge")
    expect(run({ review: review({ findings: [{ kind: "security", severity: "high", path: "a.ts", title: "t", body: "b" }] }), policy: { merge: { risk: "high" } } }).action).toBe("hold")
    expect(run({ review: review({ merge: false, reason: "Dated price content." }) })).toEqual({ action: "hold", reason: "Dated price content." })
  })
})

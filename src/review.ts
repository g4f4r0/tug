import { readFileSync } from "node:fs"
import { z } from "zod"
import { parsePolicy, reviewPolicy, riskRank, RISKS, SEVERITIES, VERSION, Review, type Finding, type ReviewPolicy, type Risk } from "./contracts.ts"
import { labelsMiss, passes } from "./core/filters.ts"
import { ask, type Pass, type PassSettings } from "./engine.ts"
import { fileAt, pullComments, pullFiles, pullInfo, pullReviews, setLabel, touchedPaths, type PullComment, type PullFile, type PullInfo, type Request } from "./forge/github.ts"
import { holdForHuman } from "./merge.ts"

const KINDS = ["code", "security"] as const
type Kind = (typeof KINDS)[number]
/** Only a marker that ends the body counts, so one quoted in a finding can't stand in for it. */
const MARKER = /<!-- tug:review ([A-Za-z0-9_-]+) -->\s*$/u
/** Characters of patches sent to the model; past this the review can't see the whole change, so it never says merge. */
const MAX_DIFF = 400_000
const MAX_INLINE = 20
const RISK_COLORS: Record<Risk, string> = { low: "0E8A16", medium: "FBCA04", high: "D93F0B" }

/** What one review kind answers. Every field is required, so the schema works in strict mode. */
const KindAnswer = z.strictObject({
  findings: z.array(
    z.strictObject({
      severity: z.enum(SEVERITIES),
      path: z.string(),
      line: z.number().int(),
      title: z.string(),
      body: z.string(),
      confidence: z.enum(["confirmed", "investigate"]),
    }),
  ),
  risk: z.enum(RISKS),
  merge: z.boolean(),
  reason: z.string(),
})
type KindAnswer = z.infer<typeof KindAnswer>

/** The review a marker carries, or null when it is missing or invalid. */
export function readMarker(body: string): Review | null {
  const match = MARKER.exec(body)
  if (!match) return null
  try {
    return Review.parse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")))
  } catch {
    return null
  }
}

export const writeMarker = (review: Review) => `<!-- tug:review ${Buffer.from(JSON.stringify(review)).toString("base64url")} -->`

/** The reviews Tug posted, by the account `reviewer`, oldest first. */
async function tugReviews(request: Request, repo: string, number: number, reviewer: string): Promise<Review[]> {
  return (await pullReviews(request, repo, number)).filter((posted) => posted.author === reviewer).flatMap((posted) => {
    const review = readMarker(posted.body)
    return review && review.head === posted.commit ? [review] : []
  })
}

/** Lines on the new side of a patch that GitHub accepts an inline comment on. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>()
  let line = 0
  for (const text of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
    if (hunk) line = Number(hunk[1])
    else if (text.startsWith("+") || text.startsWith(" ")) lines.add(line++)
  }
  return lines
}

/** The pull request as the model reads it, and whether every patch fit. */
export function describePull(pull: PullInfo, files: PullFile[], rules: string[], earlier: Finding[], comments: PullComment[] = []): { text: string; complete: boolean } {
  let used = 0
  let complete = true
  const parts = files.map((file) => {
    const header = `### ${file.path} (${file.status}${file.previous ? ` from ${file.previous}` : ""}, +${file.additions} -${file.deletions})`
    if (file.patch === undefined) {
      if (file.additions + file.deletions > 0) complete = false
      return `${header}\n(no patch: binary or too large to show)`
    }
    if (used + file.patch.length > MAX_DIFF) {
      complete = false
      return `${header}\n(patch left out: the diff is too large)`
    }
    used += file.patch.length
    return `${header}\n\`\`\`diff\n${file.patch}\n\`\`\``
  })
  const text = [
    `Title: ${pull.title}`,
    `Author: ${pull.author}`,
    `Base branch: ${pull.base}`,
    `Body:\n${pull.body || "(empty)"}`,
    `Comments, newest last:\n${comments.length > 0 ? comments.map((comment) => `- ${comment.author}: ${comment.body.slice(0, 1000)}`).join("\n") : "(none)"}`,
    `Repository rules:\n${rules.length > 0 ? rules.map((rule) => `- ${rule}`).join("\n") : "(none)"}`,
    `Findings already raised on earlier commits, not to raise again:\n${earlier.length > 0 ? earlier.map((finding) => `- ${finding.path}:${finding.line ?? 0} ${finding.title}`).join("\n") : "(none)"}`,
    `Changed files (${files.length}):\n\n${parts.join("\n\n")}`,
  ].join("\n\n")
  return { text, complete }
}

const key = (finding: Pick<Finding, "path" | "title">) => `${finding.path}\n${finding.title.toLowerCase()}`
const rank = (severity: Finding["severity"]) => SEVERITIES.indexOf(severity)
const maxRisk = (...risks: Risk[]) => RISKS[Math.max(...risks.map(riskRank))]!

/** Combines the answers of the kinds that ran into one review of `head`, never lower in risk than `earlier`, without re-raised findings. */
export function combine(head: string, answers: Partial<Record<Kind, KindAnswer>>, earlier: Review | null, complete: boolean): Review {
  const given = KINDS.flatMap((kind) => (answers[kind] ? [{ kind, answer: answers[kind] }] : []))
  const raised = new Set((earlier?.findings ?? []).map(key))
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const { kind, answer } of given) {
    for (const found of answer.findings) {
      const finding: Finding = { kind, severity: found.severity, path: found.path, title: found.title, body: found.confidence === "investigate" ? `${found.body} (investigate)` : found.body, ...(found.line > 0 ? { line: found.line } : {}) }
      if (raised.has(key(finding)) || seen.has(key(finding))) continue
      seen.add(key(finding))
      findings.push(finding)
    }
  }
  findings.sort((a, b) => rank(a.severity) - rank(b.severity))
  const blocking = findings.some((finding) => rank(finding.severity) <= rank("high"))
  const risk = maxRisk(...given.map(({ answer }) => answer.risk), blocking ? "high" : "low", earlier?.risk ?? "low")
  const holding = given.find(({ answer }) => !answer.merge)
  const merge = complete && given.length > 0 && !holding && risk === "low"
  const reason = !complete ? "The diff is too large to review whole." : (holding ?? given[0])?.answer.reason ?? ""
  return { version: VERSION, head, findings, risk, merge, reason: reason.slice(0, 200) || "No reason given." }
}

const severityName = (severity: Finding["severity"]) => severity[0]!.toUpperCase() + severity.slice(1)

/** The review body and inline comments GitHub gets. */
export function render(review: Review, files: PullFile[], since: string | null): { body: string; comments: { path: string; line: number; side: "RIGHT"; body: string }[] } {
  const lines = new Map(files.map((file) => [file.path, commentableLines(file.patch)]))
  const comments: { path: string; line: number; side: "RIGHT"; body: string }[] = []
  const elsewhere: string[] = []
  for (const finding of review.findings) {
    const text = `${severityName(finding.severity)} · ${finding.kind === "security" ? "Security: " : ""}${finding.title}\n${finding.body}`
    if (finding.line && lines.get(finding.path)?.has(finding.line) && comments.length < MAX_INLINE) comments.push({ path: finding.path, line: finding.line, side: "RIGHT", body: text })
    else elsewhere.push(`- ${finding.path}${finding.line ? `:${finding.line}` : ""}: ${severityName(finding.severity)} · ${finding.title}. ${finding.body}`)
  }
  const count = review.findings.length
  const high = review.findings.filter((finding) => rank(finding.severity) <= rank("high")).length
  const issues = count === 0 ? "" : `${count} ${since ? "new " : ""}issue${count === 1 ? "" : "s"}${high > 0 ? `, ${high} of them high` : ""}`
  const result = count === 0 ? (since ? `No new issues since ${since.slice(0, 7)}.` : "No issues were found.") : `Found ${issues}${since ? ` since ${since.slice(0, 7)}` : ""}.`
  const body = [result, elsewhere.join("\n"), `Risk: ${review.risk}. ${review.merge ? "Merge: yes" : "Merge: no"}. ${review.reason}`, writeMarker(review)].filter(Boolean).join("\n\n")
  return { body, comments }
}

const labelsOf = async (request: Request, repo: string, number: number) => ((await request<{ labels?: { name?: string }[] }>("GET", `/repos/${repo}/issues/${number}`)).labels ?? []).map((label) => label.name ?? "")

/** A posted review, and whether a new critical or high finding fails the check; or why Tug did not review. */
type ReviewResult = { review: Review; failed: boolean } | { skipped: string }

/** Why Tug doesn't review this pull request at all under `settings`, or null when it does. */
export function skipReason(settings: ReviewPolicy, pull: PullInfo): string | null {
  const filters = settings.filters ?? {}
  if (!settings.code && !settings.security) return "review.code and review.security are off"
  if (pull.draft && !settings.drafts) return "draft"
  if (!passes(filters.authors, pull.author, { caseless: true })) return `author ${pull.author}`
  if (!passes(filters.branches, pull.base)) return `base branch ${pull.base}`
  const label = labelsMiss(filters.labels, pull.labels)
  if (label !== null) return label ? `label ${label}` : "no label matches review.filters.labels"
  return null
}

/** The files the review reads: those with a path in `review.filters.paths`, both sides of a rename counted. */
export const reviewedFiles = (settings: ReviewPolicy, files: PullFile[]) => files.filter((file) => touchedPaths([file]).some((path) => passes(settings.filters?.paths, path)))

/**
 * Reviews the pull request's head with each kind `tug.json` turns on, posts one COMMENT review, and sets its `risk:*`
 * label. It posts nothing when the policy skips the pull request, and at `review.max` it adds `needs:human` instead.
 */
export async function runReview(input: { request: Request; repo: string; number: number; settings: () => Record<Pass, PassSettings>; reviewer: string; promptsDir: URL }): Promise<ReviewResult> {
  const { request, repo, number } = input
  const pull = await pullInfo(request, repo, number)
  // The policy comes from the base branch, so a pull request can't loosen its own review.
  const policy = parsePolicy(await fileAt(request, repo, "tug.json", pull.baseSha))
  const settings = reviewPolicy(policy)
  const skipped = skipReason(settings, pull)
  if (skipped) return { skipped }
  const [done, files, conversation] = await Promise.all([
    tugReviews(request, repo, number, input.reviewer),
    pullFiles(request, repo, pull.baseSha, pull.head, pull.changedFiles),
    pullComments(request, repo, number),
  ])
  const reviewed = reviewedFiles(settings, files)
  if (settings.filters?.paths && reviewed.length === 0) return { skipped: "no file matches review.filters.paths" }
  if (settings.max !== undefined && done.length >= settings.max) {
    await holdForHuman(request, repo, number, pull.labels, `Tug reached its limit of ${settings.max} reviews on this pull request, so a person takes it from here.`)
    return { skipped: `review limit ${settings.max} reached` }
  }
  const earlier = done.at(-1) ?? null
  const earlierFindings = done.flatMap((review) => review.findings)
  const { text, complete } = describePull(pull, reviewed, policy.rules ?? [], earlierFindings, conversation)
  const models = input.settings()
  const answers = Object.fromEntries(
    await Promise.all(
      KINDS.filter((kind) => settings[kind]).map(async (kind) => [kind, await ask({ settings: models[kind], system: readFileSync(new URL(`${kind}.md`, input.promptsDir), "utf8"), user: text, schema: KindAnswer, name: `tug_${kind}_review` })] as const),
    ),
  ) as Partial<Record<Kind, KindAnswer>>
  const review = combine(pull.head, answers, earlier ? { ...earlier, findings: earlierFindings } : null, complete)

  const now = await pullInfo(request, repo, number)
  if (now.head !== pull.head) throw new Error(`The head moved from ${pull.head.slice(0, 7)} to ${now.head.slice(0, 7)} during the review; nothing was posted`)
  const { body, comments } = render(review, reviewed, earlier?.head ?? null)
  await request("POST", `/repos/${repo}/pulls/${number}/reviews`, { body: { commit_id: pull.head, event: "COMMENT", body, comments } })
  await setLabel(request, repo, number, `risk:${review.risk}`, await labelsOf(request, repo, number), RISK_COLORS[review.risk])
  return { review, failed: review.findings.some((finding) => rank(finding.severity) <= rank("high")) }
}

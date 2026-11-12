import { readFileSync } from "node:fs"
import { z } from "zod"
import { parsePolicy, riskRank, RISKS, SEVERITIES, VERSION, Review, type Finding, type Risk } from "./contracts.ts"
import { ask, type Pass, type PassSettings } from "./engine.ts"
import { fileAt, pullComments, pullFiles, pullInfo, pullReviews, setLabel, type PullComment, type PullFile, type PullInfo, type Request } from "./forge/github.ts"

export const KINDS = ["code", "security"] as const
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
export async function tugReviews(request: Request, repo: string, number: number, reviewer: string): Promise<Review[]> {
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

/** Combines the kinds' answers into one review of `head`, never lower in risk than `earlier`, without re-raised findings. */
export function combine(head: string, answers: Record<(typeof KINDS)[number], KindAnswer>, earlier: Review | null, complete: boolean): Review {
  const raised = new Set((earlier?.findings ?? []).map(key))
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const kind of KINDS) {
    for (const found of answers[kind].findings) {
      const finding: Finding = { kind, severity: found.severity, path: found.path, title: found.title, body: found.confidence === "investigate" ? `${found.body} (investigate)` : found.body, ...(found.line > 0 ? { line: found.line } : {}) }
      if (raised.has(key(finding)) || seen.has(key(finding))) continue
      seen.add(key(finding))
      findings.push(finding)
    }
  }
  findings.sort((a, b) => rank(a.severity) - rank(b.severity))
  const blocking = findings.some((finding) => rank(finding.severity) <= rank("high"))
  const risk = maxRisk(answers.code.risk, answers.security.risk, blocking ? "high" : "low", earlier?.risk ?? "low")
  const holding = KINDS.find((kind) => !answers[kind].merge)
  const merge = complete && !holding && risk === "low"
  const reason = !complete ? "The diff is too large to review whole." : holding ? answers[holding].reason : answers.code.reason
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

export interface ReviewResult {
  review: Review
  /** A new critical or high finding: the check fails. */
  failed: boolean
}

/** Reviews the pull request's head with every kind, posts one COMMENT review, and sets its `risk:*` label. */
export async function runReview(input: { request: Request; repo: string; number: number; settings: Record<Pass, PassSettings>; reviewer: string; promptsDir: URL; model?: typeof fetch }): Promise<ReviewResult> {
  const { request, repo, number } = input
  const pull = await pullInfo(request, repo, number)
  const done = await tugReviews(request, repo, number, input.reviewer)
  const earlier = done.at(-1) ?? null
  const earlierFindings = done.flatMap((review) => review.findings)
  // The policy comes from the base branch, so a pull request can't loosen its own review.
  const policy = parsePolicy(await fileAt(request, repo, "tug.json", pull.baseSha))
  const files = await pullFiles(request, repo, pull.baseSha, pull.head, pull.changedFiles)
  const { text, complete } = describePull(pull, files, policy.rules ?? [], earlierFindings, await pullComments(request, repo, number))
  const answers = Object.fromEntries(
    await Promise.all(
      KINDS.map(async (kind) => [kind, await ask({ settings: input.settings[kind], system: readFileSync(new URL(`${kind}.md`, input.promptsDir), "utf8"), user: text, schema: KindAnswer, name: `tug_${kind}_review`, request: input.model })] as const),
    ),
  ) as Record<(typeof KINDS)[number], KindAnswer>
  const review = combine(pull.head, answers, earlier ? { ...earlier, findings: earlierFindings } : null, complete)

  const now = await pullInfo(request, repo, number)
  if (now.head !== pull.head) throw new Error(`The head moved from ${pull.head.slice(0, 7)} to ${now.head.slice(0, 7)} during the review; nothing was posted`)
  const { body, comments } = render(review, files, earlier?.head ?? null)
  await request("POST", `/repos/${repo}/pulls/${number}/reviews`, { body: { commit_id: pull.head, event: "COMMENT", body, comments } })
  await setLabel(request, repo, number, `risk:${review.risk}`, await labelsOf(request, repo, number), RISK_COLORS[review.risk])
  return { review, failed: review.findings.some((finding) => rank(finding.severity) <= rank("high")) }
}

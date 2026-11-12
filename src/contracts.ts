import { z } from "zod"

/** Every contract carries this version; a reader refuses any other. */
export const VERSION = 1 as const

export const RISKS = ["low", "medium", "high"] as const
export type Risk = (typeof RISKS)[number]
export const riskRank = (risk: Risk) => RISKS.indexOf(risk)

const STATES = ["MERGED", "CLOSED", "HELD", "CONFLICTS", "CHECKS", "THREADS", "PENDING", "READY"] as const
export type PullStateName = (typeof STATES)[number]

/** A pull request's head as the forge reports it: what a merge and a follow-up are gated on. */
export const PullState = z.strictObject({
  version: z.literal(VERSION),
  repo: z.string(),
  number: z.number().int().positive(),
  state: z.enum(STATES),
  head: z.string(),
  base: z.string(),
  title: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  /** Checks that concluded success, neutral or skipped. */
  passed: z.array(z.string()),
  /** Checks that concluded failure, error, cancelled, timed_out, action_required, startup_failure or stale. */
  failed: z.array(z.string()),
  /** Checks not finished yet, and required checks the head does not have yet. */
  pending: z.array(z.string()),
  /** Unresolved review threads. */
  threads: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
})
export type PullState = z.infer<typeof PullState>

export const SEVERITIES = ["critical", "high", "medium", "low"] as const

export const Finding = z.strictObject({
  /** The review kind that raised it, such as code or security. */
  kind: z.string().min(1),
  severity: z.enum(SEVERITIES),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  body: z.string(),
})
export type Finding = z.infer<typeof Finding>

/** One review of one head: what an engine returns and the merge reads. */
export const Review = z.strictObject({
  version: z.literal(VERSION),
  head: z.string().min(1),
  findings: z.array(Finding),
  risk: z.enum(RISKS),
  /** Whether the reviewer judged the change safe to merge without a human. */
  merge: z.boolean(),
  reason: z.string().min(1),
})
export type Review = z.infer<typeof Review>

const patterns = z.array(z.string().min(1)).min(1)

/** Which pull requests a section applies to. */
const Filters = z.strictObject({
  /** The pull request's author. */
  authors: patterns.optional(),
  /** The pull request's base branch. */
  branches: patterns.optional(),
  /** The pull request's labels: none may be excluded, and with an include pattern, one must match. */
  labels: patterns.optional(),
  /** Merge: every changed file must pass. Review: only the files that pass are reviewed. */
  paths: patterns.optional(),
})

const ReviewPolicy = z.strictObject({
  /** The code pass. */
  code: z.boolean().default(true),
  /** The security pass. */
  security: z.boolean().default(true),
  /** Whether draft pull requests are reviewed. */
  drafts: z.boolean().default(false),
  /** The most Tug reviews per pull request. */
  max: z.number().int().positive().optional(),
  filters: Filters.optional(),
})
export type ReviewPolicy = z.infer<typeof ReviewPolicy>

/** `tug.json` at the repository root. Unknown keys are errors, so a typo never drops a filter. */
export const Policy = z.strictObject({
  $schema: z.string().optional(),
  /** Absent: Tug runs both passes on every pull request that isn't a draft. */
  review: ReviewPolicy.optional(),
  /** Absent: Tug reviews and never merges. */
  merge: z
    .strictObject({
      /** The highest risk that merges by itself. */
      risk: z.enum(RISKS),
      filters: Filters.optional(),
    })
    .optional(),
  /** Repository rules the reviewer reads on top of Tug's defaults. */
  rules: z.array(z.string().min(1)).optional(),
})
export type Policy = z.infer<typeof Policy>

/** The policy's review settings, with their defaults when `tug.json` has no `review`. */
export const reviewPolicy = (policy: Policy): ReviewPolicy => policy.review ?? ReviewPolicy.parse({})

/** Parses `tug.json` text; a missing file is an empty policy. Throws on invalid JSON or shape. */
export function parsePolicy(text: string | null): Policy {
  if (text === null) return {}
  const policy = Policy.parse(JSON.parse(text))
  // A merge reads the review of its head, so with no pass on, nothing could ever merge.
  if (policy.merge && !reviewPolicy(policy).code && !reviewPolicy(policy).security) throw new Error("tug.json: merge needs review.code or review.security")
  return policy
}

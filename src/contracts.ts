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

/** `tug.json` at the repository root. Unknown keys are errors, so a typo never drops a filter. */
export const Policy = z.strictObject({
  $schema: z.string().optional(),
  /** Absent: Tug reviews and never merges. */
  merge: z
    .strictObject({
      /** The highest risk that merges by itself. */
      risk: z.enum(RISKS),
      filters: z
        .strictObject({
          /** Who may be auto-merged. */
          authors: patterns.optional(),
          /** The pull request's base branch. */
          branches: patterns.optional(),
          /** Every changed file must pass. */
          paths: patterns.optional(),
        })
        .optional(),
    })
    .optional(),
  /** Repository rules the reviewer reads on top of Tug's defaults. */
  rules: z.array(z.string().min(1)).optional(),
})
export type Policy = z.infer<typeof Policy>

/** Parses `tug.json` text; a missing file is an empty policy. Throws on invalid JSON or shape. */
export function parsePolicy(text: string | null): Policy {
  if (text === null) return {}
  return Policy.parse(JSON.parse(text))
}

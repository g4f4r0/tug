import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { PullState } from "../contracts.ts"
import { state, type PullFacts, type StateOptions } from "../core/state.ts"

type Json = Record<string, unknown>

/** One GitHub API call. Paths are relative to the API root, such as `/repos/o/r/pulls/1` or `/graphql`. */
export type Request = <T>(method: string, path: string, options?: { body?: unknown }) => Promise<T>

export class GitHubError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/** The token from `GITHUB_TOKEN` or `GH_TOKEN`, else from `gh auth token`. */
export async function token(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 10_000 })
    if (stdout.trim()) return stdout.trim()
  } catch {
    // Falls through to the error below.
  }
  throw new GitHubError("No GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`.")
}

/** A `Request` over fetch, against `GITHUB_API_URL` or api.github.com. */
export function client(auth: string, options: { api?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Request {
  const api = (options.api ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "")
  const call = options.fetch ?? fetch
  return async <T>(method: string, path: string, init: { body?: unknown } = {}): Promise<T> => {
    const response = await call(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "tug",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300)
      try {
        message = String((JSON.parse(text) as Json).message ?? message)
      } catch {
        // Keeps the raw text.
      }
      throw new GitHubError(`GitHub answered ${response.status} to ${method} ${path.split("?")[0]}: ${message}`, response.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { nodes { isResolved } pageInfo { hasNextPage endCursor } } }
  }
}`
/** Pages read of each list before the read fails closed: 1,000 checks, statuses or threads. */
const MAX_PAGES = 10

const str = (value: unknown): string => (typeof value === "string" ? value : "")
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])

/**
 * Reads a pull request, the checks and statuses of its head and its review threads. A merged or closed pull request
 * is read no further. When mergeability is not computed yet, it reads the pull request once more after two seconds.
 */
export async function readPull(input: { request: Request; repo: string; number: number; wait?: (ms: number) => Promise<void> }): Promise<PullFacts> {
  const { request, repo, number } = input
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pullPath = `/repos/${repo}/pulls/${number}`
  let pull = await request<Json>("GET", pullPath)
  const facts = (from: Json): PullFacts => ({
    repo,
    number,
    state: from.state === "closed" ? "closed" : "open",
    merged: from.merged === true,
    draft: from.draft === true,
    mergeable: typeof from.mergeable === "boolean" ? from.mergeable : null,
    mergeableState: str(from.mergeable_state),
    head: str((from.head as Json | undefined)?.sha),
    base: str((from.base as Json | undefined)?.ref),
    title: str(from.title),
    author: str((from.user as Json | undefined)?.login),
    labels: list(from.labels).map((label) => str(label.name)),
  })
  if (pull.merged === true || pull.state === "closed") return facts(pull)
  if (typeof pull.mergeable !== "boolean") {
    await wait(2_000)
    pull = await request<Json>("GET", pullPath)
  }
  const read = facts(pull)
  const head = read.head

  // Every list is read to its end, or the read fails: a check or thread left unread must never make a head READY.
  const all = async (path: string, key: string): Promise<Json[]> => {
    const items: Json[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await request<Json>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
      const entries = list(batch[key])
      items.push(...entries)
      const total = typeof batch.total_count === "number" ? batch.total_count : null
      if (entries.length < 100 || (total !== null && items.length >= total)) return items
    }
    throw new GitHubError(`${repo}#${number} has more than ${MAX_PAGES * 100} ${key.replace("_", " ")}`)
  }
  const runs = await all(`/repos/${repo}/commits/${head}/check-runs?filter=latest`, "check_runs")
  const superseded = await supersededSuites(request, repo, head)
  const checks = runs
    .filter((run) => !superseded.has(Number((run.check_suite as Json | undefined)?.id)))
    .map((run) => ({
      name: str(run.name),
      status: str(run.status),
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    }))
  const statuses = (await all(`/repos/${repo}/commits/${head}/status`, "statuses")).map((status) => ({ context: str(status.context), state: str(status.state) }))

  const [owner, name] = repo.split("/") as [string, string]
  let threads = 0
  let after: string | null = null
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new GitHubError(`${repo}#${number} has more than ${MAX_PAGES * 100} review threads`)
    const graph: {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } }
      errors?: { message?: string }[]
    } = await request("POST", "/graphql", { body: { query: THREADS_QUERY, variables: { owner, name, number, after } } })
    if (graph.errors?.length) throw new GitHubError(`GitHub could not list the review threads of ${repo}#${number}: ${graph.errors.map((error) => error.message ?? "unknown error").join("; ")}`)
    const found = graph.data?.repository?.pullRequest?.reviewThreads
    if (!found) throw new GitHubError(`GitHub returned no review threads for ${repo}#${number}`)
    threads += (found.nodes ?? []).filter((node) => node.isResolved !== true).length
    if (!found.pageInfo?.hasNextPage) break
    after = found.pageInfo.endCursor ?? null
  }
  return { ...read, checks, statuses, threads }
}

/** Reads a pull request and names its state. */
export async function pullState(input: { request: Request; repo: string; number: number; wait?: (ms: number) => Promise<void> } & StateOptions): Promise<PullState> {
  return state(await readPull(input), input)
}

/**
 * The check suites of workflow runs that `concurrency` cancelled because a newer run of the same workflow started on
 * this head: their checks are superseded, not failed. Without `actions: read`, none are, so those checks still fail.
 */
async function supersededSuites(request: Request, repo: string, head: string): Promise<Set<number>> {
  let runs: Json[]
  try {
    runs = list((await request<Json>("GET", `/repos/${repo}/actions/runs?head_sha=${head}&per_page=100`)).workflow_runs)
  } catch {
    return new Set()
  }
  const newest = new Map<number, number>()
  for (const run of runs) newest.set(Number(run.workflow_id), Math.max(newest.get(Number(run.workflow_id)) ?? 0, Number(run.id)))
  return new Set(runs.filter((run) => run.conclusion === "cancelled" && Number(run.id) < (newest.get(Number(run.workflow_id)) ?? 0)).map((run) => Number(run.check_suite_id)))
}

export interface PullFile {
  path: string
  /** The path before a rename. */
  previous?: string
  status: string
  additions: number
  deletions: number
  /** Absent for binary files and patches GitHub won't show. */
  patch?: string
}

/**
 * The files changed from the merge base of `base` to `head`, read by commit so a push during a review can't swap them.
 * Throws unless that is all `expected` of them: GitHub lists at most 300.
 */
export async function pullFiles(request: Request, repo: string, base: string, head: string, expected: number): Promise<PullFile[]> {
  const compare = await request<{ files?: Json[] }>("GET", `/repos/${repo}/compare/${base}...${head}?per_page=1`)
  const files = (compare.files ?? []).map((file) => ({ path: str(file.filename), ...(typeof file.previous_filename === "string" ? { previous: file.previous_filename } : {}), status: str(file.status), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, patch: typeof file.patch === "string" ? file.patch : undefined }))
  if (files.length !== expected) throw new GitHubError(`GitHub listed ${files.length} of the ${expected} changed files of ${head.slice(0, 7)}, so Tug can't see the whole change`)
  return files
}

/** Every path a change touches, both sides of a rename included. */
export const touchedPaths = (files: readonly PullFile[]) => files.flatMap((file) => (file.previous ? [file.previous, file.path] : [file.path]))

export interface PullInfo {
  title: string
  body: string
  head: string
  base: string
  baseSha: string
  author: string
  draft: boolean
  changedFiles: number
}

export async function pullInfo(request: Request, repo: string, number: number): Promise<PullInfo> {
  const pull = await request<Json>("GET", `/repos/${repo}/pulls/${number}`)
  const head = (pull.head as Json | undefined) ?? {}
  const base = (pull.base as Json | undefined) ?? {}
  return { title: str(pull.title), body: str(pull.body), head: str(head.sha), base: str(base.ref), baseSha: str(base.sha), author: str((pull.user as Json | undefined)?.login), draft: pull.draft === true, changedFiles: Number(pull.changed_files) || 0 }
}

/** A file's text at a ref, or null when it doesn't exist. */
export async function fileAt(request: Request, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const file = await request<Json>("GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
    return Buffer.from(str(file.content), "base64").toString("utf8")
  } catch (error) {
    if ((error as GitHubError).status === 404) return null
    throw error
  }
}

export interface PostedReview {
  author: string
  commit: string
  body: string
}

export async function pullReviews(request: Request, repo: string, number: number): Promise<PostedReview[]> {
  const reviews: PostedReview[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await request<Json[]>("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`)
    for (const review of batch) reviews.push({ author: str((review.user as Json | undefined)?.login), commit: str(review.commit_id), body: str(review.body) })
    if (batch.length < 100) return reviews
  }
  throw new GitHubError(`${repo}#${number} has more than 1000 reviews`)
}

/** Sets one label of a group, such as `risk:low`, removing the group's others. Creates the label when the repository lacks it. */
export async function setLabel(request: Request, repo: string, number: number, label: string, labels: string[], color = "ededed"): Promise<void> {
  const group = `${label.split(":")[0]}:`
  for (const other of labels.filter((name) => name.startsWith(group) && name !== label)) {
    await request("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(other)}`).catch((error: GitHubError) => {
      if (error.status !== 404) throw error
    })
  }
  if (labels.includes(label)) return
  await request("POST", `/repos/${repo}/labels`, { body: { name: label, color } }).catch((error: GitHubError) => {
    if (error.status !== 422) throw error
  })
  await request("POST", `/repos/${repo}/issues/${number}/labels`, { body: { labels: [label] } })
}

export interface PullComment {
  author: string
  body: string
}

/** The pull request's conversation comments, oldest first; past 1000, the review can't see them all and throws. */
export async function pullComments(request: Request, repo: string, number: number): Promise<PullComment[]> {
  const comments: PullComment[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await request<Json[]>("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)
    for (const comment of batch) comments.push({ author: str((comment.user as Json | undefined)?.login), body: str(comment.body) })
    if (batch.length < 100) return comments
  }
  throw new GitHubError(`${repo}#${number} has more than 1000 comments`)
}

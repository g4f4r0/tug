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
  const checks = (await all(`/repos/${repo}/commits/${head}/check-runs?filter=latest`, "check_runs")).map((run) => ({
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

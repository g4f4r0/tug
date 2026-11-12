import { describe, expect, it } from "vitest"
import { client, pullState, type Request } from "../src/forge/github.ts"

const HEAD = "a".repeat(40)
const REPO = "g4f4r0/opencode-plugins"

interface StateFacts {
  pulls?: Record<string, unknown>[]
  runs?: Record<string, unknown>[]
  workflowRuns?: Record<string, unknown>[]
  statuses?: Record<string, unknown>[]
  threads?: boolean[]
  errors?: boolean
}

/** A pull request whose head is ready, unless `facts` say otherwise; each read of the pull request takes the next of `pulls`. */
function stateRequest(facts: StateFacts = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  let reads = 0
  const request = async <T,>(method: string, path: string, options: { body?: unknown } = {}): Promise<T> => {
    calls.push({ method, path: path.split("?")[0]!, body: options.body })
    if (method === "GET" && /\/pulls\/12$/u.test(path)) {
      const pulls = facts.pulls ?? [{}]
      return {
        number: 12,
        title: "Add the thing",
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        labels: [],
        user: { login: "g4f4r0" },
        head: { sha: HEAD },
        base: { ref: "main" },
        ...pulls[Math.min(reads++, pulls.length - 1)],
      } as T
    }
    if (method === "GET" && path.includes("/actions/runs")) {
      if (!facts.workflowRuns) throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 })
      return { workflow_runs: facts.workflowRuns } as T
    }
    if (method === "GET" && path.includes("/check-runs")) return { check_runs: facts.runs ?? [{ name: "build", status: "completed", conclusion: "success" }] } as T
    if (method === "GET" && path.split("?")[0]!.endsWith("/status")) return { statuses: facts.statuses ?? [] } as T
    if (method === "POST" && path === "/graphql") {
      if (facts.errors) return { errors: [{ message: "Resource not accessible" }] } as T
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: (facts.threads ?? []).map((isResolved) => ({ isResolved })) } } } } } as T
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { calls, request: request as Request }
}

const failing = (...names: string[]) => names.map((name) => ({ name, status: "completed", conclusion: "failure" }))

describe("the pull request's state", () => {
  const read = async (facts: StateFacts = {}, ignore: string[] = []) => {
    const t = stateRequest(facts)
    const waits: number[] = []
    const state = await pullState({ request: t.request, repo: REPO, number: 12, ignore, wait: async (ms) => void waits.push(ms) })
    return { state, waits, calls: t.calls }
  }

  it("drops the checks of a workflow run that a newer run of the same workflow superseded", async () => {
    const runs = [{ name: "test", status: "completed", conclusion: "cancelled", check_suite: { id: 10 } }, { name: "test", status: "in_progress", conclusion: null, check_suite: { id: 20 } }]
    const workflowRuns = [{ id: 1, workflow_id: 7, event: "pull_request", conclusion: "cancelled", check_suite_id: 10 }, { id: 2, workflow_id: 7, event: "pull_request", conclusion: null, check_suite_id: 20 }]
    expect((await read({ runs, workflowRuns })).state).toMatchObject({ state: "PENDING", failed: [], pending: ["test"] })
    // Another workflow's cancelled run, or no actions: read, still fails.
    expect((await read({ runs, workflowRuns: [{ ...workflowRuns[0]!, workflow_id: 8 }, workflowRuns[1]!] })).state).toMatchObject({ state: "CHECKS", failed: ["test"] })
    expect((await read({ runs })).state).toMatchObject({ state: "CHECKS", failed: ["test"] })
    // A newer run for another event, or without the same check, replaces nothing.
    expect((await read({ runs, workflowRuns: [workflowRuns[0]!, { ...workflowRuns[1]!, event: "workflow_dispatch" }] })).state).toMatchObject({ failed: ["test"] })
    expect((await read({ runs: [runs[0]!, { ...runs[1]!, name: "lint" }], workflowRuns })).state).toMatchObject({ failed: ["test"] })
  })

  it("is ready when nothing holds the head back", async () => {
    const { state, calls } = await read()
    expect(state).toEqual({
      version: 1,
      repo: REPO,
      number: 12,
      state: "READY",
      head: HEAD,
      base: "main",
      title: "Add the thing",
      author: "g4f4r0",
      labels: [],
      passed: ["build"],
      failed: [],
      pending: [],
      threads: 0,
      reasons: [],
    })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/${REPO}/pulls/12`,
      `GET /repos/${REPO}/commits/${HEAD}/check-runs`,
      `GET /repos/${REPO}/actions/runs`,
      `GET /repos/${REPO}/commits/${HEAD}/status`,
      "POST /graphql",
    ])
    expect(calls[4]!.body).toMatchObject({ variables: { owner: "g4f4r0", name: "opencode-plugins", number: 12 } })
  })

  it("ends at merged or closed without reading checks", async () => {
    const merged = await read({ pulls: [{ state: "closed", merged: true }] })
    expect(merged.state.state).toBe("MERGED")
    expect(merged.calls).toHaveLength(1)
    expect((await read({ pulls: [{ state: "closed" }] })).state.state).toBe("CLOSED")
  })

  it("names the first of hold, conflicts, failed checks, threads and pending work", async () => {
    const hold = await read({ pulls: [{ labels: [{ name: "Merge:Hold" }], mergeable: false }], runs: failing("build") })
    expect(hold.state).toMatchObject({ state: "HELD", reasons: ["label merge:hold", "merge conflicts"] })
    expect((await read({ pulls: [{ labels: [{ name: "needs:human" }] }] })).state).toMatchObject({ state: "HELD", reasons: ["label needs:human"] })
    expect((await read({ pulls: [{ mergeable: false }], threads: [false] })).state.state).toBe("CONFLICTS")
    expect((await read({ pulls: [{ mergeable_state: "dirty" }] })).state.state).toBe("CONFLICTS")
    const checks = await read({ runs: [{ name: "build", status: "completed", conclusion: "timed_out" }, { name: "lint", status: "queued" }, { name: "docs", status: "completed", conclusion: "skipped" }], threads: [false] })
    expect(checks.state).toMatchObject({ state: "CHECKS", failed: ["build"], pending: ["lint"], threads: 1 })
    const status = await read({ statuses: [{ context: "ci/legacy", state: "error" }, { context: "ci/slow", state: "pending" }, { context: "ci/ok", state: "success" }] })
    expect(status.state).toMatchObject({ state: "CHECKS", failed: ["ci/legacy"], pending: ["ci/slow"] })
    expect((await read({ threads: [true, false, false] })).state).toMatchObject({ state: "THREADS", threads: 2 })
    expect((await read({ runs: [{ name: "build", status: "in_progress" }] })).state).toMatchObject({ state: "PENDING", pending: ["build"] })
    expect((await read({ pulls: [{ draft: true }] })).state).toMatchObject({ state: "PENDING", reasons: ["draft"] })
  })

  it("reads once more after two seconds when mergeability is not computed, and stays pending when it still is not", async () => {
    const settled = await read({ pulls: [{ mergeable: null }, { mergeable: true }] })
    expect(settled.state.state).toBe("READY")
    expect(settled.waits).toEqual([2_000])
    expect(settled.calls.filter((call) => call.path.endsWith("/pulls/12"))).toHaveLength(2)
    const unknown = await read({ pulls: [{ mergeable: null }] })
    expect(unknown.state).toMatchObject({ state: "PENDING", reasons: ["mergeability not computed yet"] })
    expect(unknown.calls.filter((call) => call.path.endsWith("/pulls/12"))).toHaveLength(2)
  })

  it("does not count an ignored check, such as the merge job's own run", async () => {
    const claims = { runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "merge", status: "in_progress" }] }
    expect((await read(claims)).state.state).toBe("PENDING")
    expect((await read(claims, ["merge"])).state).toMatchObject({ state: "READY", pending: [] })
    expect((await read({ statuses: [{ context: "merge", state: "failure" }] }, ["merge"])).state.state).toBe("READY")
  })

  it("waits for a required check or status the head does not have yet", async () => {
    const t = stateRequest({ statuses: [{ context: "ci", state: "success" }] })
    const missing = await pullState({ request: t.request, repo: REPO, number: 12, require: ["review"] })
    expect(missing).toMatchObject({ state: "PENDING", pending: ["review (not posted)"] })
    const status = stateRequest({ statuses: [{ context: "review", state: "success" }] })
    expect((await pullState({ request: status.request, repo: REPO, number: 12, require: ["review"] })).state).toBe("READY")
    const run = stateRequest({ runs: [{ name: "review", status: "completed", conclusion: "success" }] })
    expect((await pullState({ request: run.request, repo: REPO, number: 12, require: ["review"] })).state).toBe("READY")
  })

  it("reads every page of threads, and fails closed past the page limit", async () => {
    const pages: { nodes: { isResolved: boolean }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }[] = [
      { nodes: Array.from({ length: 100 }, () => ({ isResolved: true })), pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false, endCursor: null } },
    ]
    const t = stateRequest()
    const afters: unknown[] = []
    const request = (async <T,>(method: string, path: string, options: { body?: unknown } = {}): Promise<T> => {
      if (method === "POST" && path === "/graphql") {
        const after = (options.body as { variables: { after: string | null } }).variables.after
        afters.push(after)
        return { data: { repository: { pullRequest: { reviewThreads: pages[after === null ? 0 : 1] } } } } as T
      }
      return t.request<T>(method, path, options)
    }) as Request
    expect(await pullState({ request, repo: REPO, number: 12 })).toMatchObject({ state: "THREADS", threads: 1 })
    expect(afters).toEqual([null, "c1"])
    const endless = (async <T,>(method: string, path: string, options: { body?: unknown } = {}): Promise<T> =>
      method === "POST" && path === "/graphql" ? ({ data: { repository: { pullRequest: { reviewThreads: pages[0] } } } } as T) : t.request<T>(method, path, options)) as Request
    await expect(pullState({ request: endless, repo: REPO, number: 12 })).rejects.toThrow("more than 1000 review threads")
  })

  it("reads every page of check runs", async () => {
    const t = stateRequest()
    const request = (async <T,>(method: string, path: string, options: { body?: unknown } = {}): Promise<T> => {
      if (method === "GET" && path.includes("/check-runs")) {
        const page = Number(/[?&]page=(\d+)/u.exec(path)?.[1])
        const runs = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: `ok-${i}`, status: "completed", conclusion: "success" })) : failing("late")
        return { total_count: 101, check_runs: runs } as T
      }
      return t.request<T>(method, path, options)
    }) as Request
    expect(await pullState({ request, repo: REPO, number: 12 })).toMatchObject({ state: "CHECKS", failed: ["late"] })
  })

  it("throws when GraphQL answers with errors, or with no pull request", async () => {
    await expect(read({ errors: true })).rejects.toThrow("Resource not accessible")
    const t = stateRequest()
    const empty = (async <T,>(method: string, path: string, options: { body?: unknown } = {}): Promise<T> =>
      method === "POST" && path === "/graphql" ? ({ data: { repository: { pullRequest: null } } } as T) : t.request<T>(method, path, options)) as Request
    await expect(pullState({ request: empty, repo: REPO, number: 12 })).rejects.toThrow("no review threads")
  })
})

describe("the GitHub client", () => {
  it("sends the token and API version, and names the status and message of a failure", async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return url.includes("/missing") ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) : new Response(JSON.stringify({ ok: true }))
    }) as unknown as typeof fetch
    const request = client("tok", { api: "https://api.example/", fetch: fake })
    expect(await request("GET", "/repos/o/r")).toEqual({ ok: true })
    expect(seen[0]!.url).toBe("https://api.example/repos/o/r")
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer tok", "x-github-api-version": "2022-11-28" })
    await expect(request("GET", "/missing?page=1")).rejects.toMatchObject({ status: 404, message: "GitHub answered 404 to GET /missing: Not Found" })
  })
})

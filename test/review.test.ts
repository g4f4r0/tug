import { generateKeyPairSync, sign } from "node:crypto"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { Review } from "../src/contracts.ts"
import { ask, modelSettings } from "../src/engine.ts"
import type { Request } from "../src/forge/github.ts"
import { keysServer, verifyToken } from "../src/keys.ts"
import { runMerge } from "../src/merge.ts"
import { pullFiles } from "../src/forge/github.ts"
import { combine, commentableLines, describePull, readMarker, render, writeMarker } from "../src/review.ts"

const HEAD = "a".repeat(40)
const answer = (overrides: Record<string, unknown> = {}) => ({ findings: [], risk: "low" as const, merge: true, reason: "Docs only.", ...overrides })
const finding = (overrides: Record<string, unknown> = {}) => ({ severity: "medium" as const, path: "a.ts", line: 3, title: "Off by one", body: "Loops once too often.", confidence: "confirmed" as const, ...overrides })

describe("combine", () => {
  it("merges only when both kinds say merge at low risk and the whole diff was seen", () => {
    expect(combine(HEAD, { code: answer(), security: answer() }, null, true)).toMatchObject({ risk: "low", merge: true, reason: "Docs only." })
    expect(combine(HEAD, { code: answer(), security: answer({ merge: false, reason: "Widens a token." }) }, null, true)).toMatchObject({ merge: false, reason: "Widens a token." })
    expect(combine(HEAD, { code: answer(), security: answer() }, null, false)).toMatchObject({ merge: false, reason: "The diff is too large to review whole." })
    expect(combine(HEAD, { code: answer({ risk: "medium" }), security: answer() }, null, true).merge).toBe(false)
  })

  it("counts a critical or high finding as high risk, and never lowers an earlier risk", () => {
    expect(combine(HEAD, { code: answer(), security: answer({ findings: [finding({ severity: "critical" })] }) }, null, true)).toMatchObject({ risk: "high", merge: false })
    const earlier: Review = { version: 1, head: "b".repeat(40), findings: [], risk: "medium", merge: false, reason: "x" }
    expect(combine(HEAD, { code: answer(), security: answer() }, earlier, true)).toMatchObject({ risk: "medium", merge: false })
  })

  it("drops findings raised before or by both kinds, and sorts by severity", () => {
    const earlier: Review = { version: 1, head: "b".repeat(40), findings: [{ kind: "code", severity: "medium", path: "a.ts", line: 3, title: "off by one", body: "" }], risk: "low", merge: true, reason: "x" }
    const review = combine(HEAD, { code: answer({ findings: [finding(), finding({ title: "Null deref", severity: "low", line: 0 })] }), security: answer({ findings: [finding({ title: "SQL injection (CWE-89)", severity: "high", confidence: "investigate" })] }) }, earlier, true)
    expect(review.findings.map((f) => [f.kind, f.severity, f.title, f.line])).toEqual([["security", "high", "SQL injection (CWE-89)", 3], ["code", "low", "Null deref", undefined]])
    expect(review.findings[0]!.body).toContain("(investigate)")
  })
})

describe("markers and rendering", () => {
  const review: Review = { version: 1, head: HEAD, findings: [{ kind: "code", severity: "high", path: "a.ts", line: 2, title: "Breaks build", body: "x" }, { kind: "security", severity: "low", path: "b.ts", line: 99, title: "Weak", body: "y" }], risk: "high", merge: false, reason: "A high finding." }

  it("round-trips a review through its marker, and rejects a tampered one", () => {
    expect(readMarker(`text\n${writeMarker(review)}`)).toEqual(review)
    expect(readMarker("<!-- tug:review e30 -->")).toBeNull()
    expect(readMarker("no marker")).toBeNull()
  })

  it("comments inline only on lines in the patch, and lists the rest in the body", () => {
    expect([...commentableLines("@@ -1,2 +1,3 @@\n a\n+b\n-c\n d")]).toEqual([1, 2, 3])
    const files = [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n+b\n d" }]
    const { body, comments } = render(review, files, null)
    expect(comments).toEqual([{ path: "a.ts", line: 2, side: "RIGHT", body: "High · Breaks build\nx" }])
    expect(body).toContain("Found 2 issues, 1 of them high.")
    expect(body).toContain("- b.ts:99: Low · Weak. y")
    expect(readMarker(body)).toEqual(review)
    expect(render({ ...review, findings: [] }, files, "b".repeat(40)).body).toMatch(/^No new issues since bbbbbbb\./u)
  })
})

describe("reading the change", () => {
  const pull = { title: "t", body: "", head: HEAD, base: "main", baseSha: "c".repeat(40), author: "a", draft: false, changedFiles: 1 }
  it("counts a text change without a patch as not seen whole", () => {
    expect(describePull(pull, [{ path: "big.ts", status: "modified", additions: 9000, deletions: 0 }], [], []).complete).toBe(false)
    expect(describePull(pull, [{ path: "logo.png", status: "added", additions: 0, deletions: 0 }], [], []).complete).toBe(true)
    expect(describePull(pull, [{ path: "b.ts", previous: "a.ts", status: "renamed", additions: 0, deletions: 0, patch: "" }], [], []).text).toContain("### b.ts (renamed from a.ts")
  })

  it("refuses a change GitHub doesn't list whole", async () => {
    const request = (async () => ({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) })) as unknown as Request
    await expect(pullFiles(request, "o/r", "b", HEAD, 301)).rejects.toThrow("listed 300 of the 301")
    expect(await pullFiles(request, "o/r", "b", HEAD, 300)).toHaveLength(300)
  })
})

describe("the engine", () => {
  const schema = z.strictObject({ ok: z.boolean() })
  it("sends a strict JSON schema and the reasoning effort, and retries one bad answer", async () => {
    const bodies: Record<string, unknown>[] = []
    const answers = ["not json", JSON.stringify({ ok: true })]
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] }))
    }) as unknown as typeof fetch
    const settings = { baseUrl: "http://m/v1", model: "gpt", key: "k", reasoningEffort: "high" }
    expect(await ask({ settings, system: "s", user: "u", schema, name: "t", request: fake })).toEqual({ ok: true })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ model: "gpt", reasoning_effort: "high", response_format: { type: "json_schema", json_schema: { strict: true, schema: { additionalProperties: false } } } })
    await expect(ask({ settings, system: "s", user: "u", schema, name: "t", request: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch })).rejects.toThrow("500")
  })

  it("uses the key service with the job's OIDC token when TUG_KEYS is set", async () => {
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ value: "jwt" }))
    }) as unknown as typeof fetch
    const settings = modelSettings({ TUG_KEYS: "http://keys:8787/", ACTIONS_ID_TOKEN_REQUEST_URL: "https://t/?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "b" }, fake)
    expect(settings.baseUrl).toBe("http://keys:8787/v1")
    expect(await (settings.key as () => Promise<string>)()).toBe("jwt")
    expect(seen).toEqual(["https://t/?x=1&audience=tug"])
    expect(() => modelSettings({ TUG_KEYS: "http://keys" })).toThrow("id-token: write")
    expect(() => modelSettings({})).toThrow("Set LLM_BASE_URL, LLM_MODEL, LLM_API_KEY")
  })
})

describe("the key service", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" }
  const jwks = async () => ({ keys: [jwk] })
  const now = Date.now()
  const config = { owners: ["g4f4r0"], workflows: ["hellogafaro/tug/.github/workflows/review.yml@refs/heads/main"] }
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: "tug", exp: now / 1000 + 300, repository: "g4f4r0/x", repository_owner: "g4f4r0", job_workflow_ref: config.workflows[0], run_id: "1" }
  const jwt = (body: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }, key = privateKey) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const signed = `${part(header)}.${part(body)}`
    return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url")}`
  }

  it("accepts only GitHub's signed token for an allowed owner and workflow", async () => {
    await expect(verifyToken(jwt(claims), config, jwks, now)).resolves.toMatchObject({ repository: "g4f4r0/x" })
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    const refusals: [string, string][] = [
      [jwt(claims, undefined, other), "bad signature"],
      [jwt(claims, { alg: "none", kid: "k1" }), "alg none"],
      [jwt(claims, { alg: "RS256", kid: "k2" }), "unknown key"],
      [jwt({ ...claims, aud: "sts.amazonaws.com" }), "wrong audience"],
      [jwt({ ...claims, iss: "https://evil" }), "wrong issuer"],
      [jwt({ ...claims, exp: now / 1000 - 1 }), "expired"],
      [jwt({ ...claims, repository_owner: "someone" }), "owner someone not allowed"],
      [jwt({ ...claims, job_workflow_ref: "g4f4r0/x/.github/workflows/steal.yml@refs/pull/1/merge" }), "not allowed"],
      [jwt({ ...claims, job_workflow_ref: "hellogafaro/tug/.github/workflows/review.yml@refs/pull/9/merge" }), "not allowed"],
    ]
    for (const [token, reason] of refusals) await expect(verifyToken(token, config, jwks, now)).rejects.toThrow(reason)
  })

  it("forwards an accepted call with the real key, model and effort, and refuses the rest", async () => {
    const upstream: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }))
      upstream.push({ url, init })
      return new Response(JSON.stringify({ choices: [] }), { headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    const server = keysServer({ ...config, upstream: "http://proxy/v1", key: "real-key", model: "gpt-6.1-sol", reasoningEffort: "high" }, { request: fake, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const call = (token: string, path = "/v1/chat/completions") => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "cheap", messages: [] }) })
      expect((await call(jwt(claims))).status).toBe(200)
      expect(upstream).toHaveLength(1)
      expect(upstream[0]!.url).toBe("http://proxy/v1/chat/completions")
      expect(upstream[0]!.init.headers).toMatchObject({ authorization: "Bearer real-key" })
      expect(JSON.parse(String(upstream[0]!.init.body))).toEqual({ model: "gpt-6.1-sol", reasoning_effort: "high", messages: [] })
      expect((await call(jwt({ ...claims, repository_owner: "x" }))).status).toBe(403)
      expect((await call(jwt(claims), "/v1/models")).status).toBe(404)
      expect(upstream).toHaveLength(1)
    } finally {
      server.close()
    }
  })
})

describe("merge", () => {
  const review: Review = { version: 1, head: HEAD, findings: [], risk: "low", merge: true, reason: "Docs only." }
  function github(overrides: { policy?: string | null; review?: Review | null; runs?: Record<string, unknown>[]; labels?: string[]; files?: Record<string, unknown>[] } = {}) {
    const calls: string[] = []
    let merged = false
    const request = (async (method: string, path: string) => {
      const route = path.split("?")[0]!
      calls.push(`${method} ${route}`)
      if (method === "GET" && route.endsWith("/pulls/5")) return { state: merged ? "closed" : "open", merged, draft: false, mergeable: true, mergeable_state: "clean", title: "docs: Fix typo", changed_files: (overrides.files ?? [{}]).length, user: { login: "g4f4r0" }, labels: (overrides.labels ?? []).map((name) => ({ name })), head: { sha: HEAD }, base: { ref: "main", sha: "c".repeat(40) } }
      if (route.endsWith("/check-runs")) return { check_runs: overrides.runs ?? [{ name: "test", status: "completed", conclusion: "success" }, { name: "tug / merge", status: "in_progress", conclusion: null }] }
      if (route.endsWith("/status")) return { statuses: [] }
      if (route === "/graphql") return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
      if (route.includes("/contents/tug.json")) {
        const policy = overrides.policy === undefined ? JSON.stringify({ merge: { risk: "low" } }) : overrides.policy
        if (policy === null) throw Object.assign(new Error("404"), { status: 404 })
        return { content: Buffer.from(policy).toString("base64") }
      }
      if (route.endsWith("/reviews")) return overrides.review === null ? [] : [{ user: { login: "github-actions[bot]" }, commit_id: HEAD, body: writeMarker(overrides.review ?? review) }, { user: { login: "intruder" }, commit_id: HEAD, body: writeMarker({ ...review, reason: "fake" }) }]
      if (route.includes("/compare/")) return { files: (overrides.files ?? [{}]).map((file) => ({ filename: "README.md", status: "modified", additions: 1, deletions: 0, ...file })) }
      if (method === "PUT" && route.endsWith("/merge")) {
        merged = true
        return { merged: true }
      }
      if (method === "POST") return {}
      throw new Error(`unexpected ${method} ${route}`)
    }) as unknown as Request
    return { request, calls }
  }
  const run = (overrides: Parameters<typeof github>[0] = {}) => {
    const t = github(overrides)
    return runMerge({ request: t.request, repo: "g4f4r0/x", number: 5, reviewer: "github-actions[bot]", wait: async () => {} }).then((result) => ({ ...result, calls: t.calls }))
  }

  it("merges the exact head by squash, ignoring its own running check, and reads the merge back", async () => {
    const result = await run()
    expect(result).toMatchObject({ merged: true, decision: { action: "merge", reason: "Docs only." } })
    expect(result.calls).toContain("PUT /repos/g4f4r0/x/pulls/5/merge")
  })

  it("holds with needs:human and one comment, and trusts only the bot's review", async () => {
    const held = await run({ review: { ...review, merge: false, reason: "Prices change." } })
    expect(held.decision).toEqual({ action: "hold", reason: "Prices change." })
    expect(held.calls.filter((call) => call.startsWith("POST") && !call.endsWith("/graphql"))).toEqual(["POST /repos/g4f4r0/x/labels", "POST /repos/g4f4r0/x/issues/5/labels", "POST /repos/g4f4r0/x/issues/5/comments"])
    expect((await run({ review: null })).decision.action).toBe("hold")
    expect((await run({ labels: ["needs:human"] })).decision.action).toBe("wait")
  })

  it("checks both sides of a rename, read by the head commit", async () => {
    const renamed = await run({ files: [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml", status: "renamed" }] })
    expect(renamed.decision).toEqual({ action: "hold", reason: ".github/workflows/ci.yml changes the repository's GitHub configuration." })
    expect(renamed.calls).toContain(`GET /repos/g4f4r0/x/compare/${"c".repeat(40)}...${HEAD}`)
  })

  it("only reviews without a merge policy, and waits on another workflow's running check", async () => {
    expect((await run({ policy: null })).decision.action).toBe("wait")
    const pending = await run({ runs: [{ name: "deploy-preview", status: "in_progress", conclusion: null }] })
    expect(pending.decision).toMatchObject({ action: "wait" })
    expect(pending.calls.some((call) => call.startsWith("PUT"))).toBe(false)
  })
})

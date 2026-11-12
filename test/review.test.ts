import { generateKeyPairSync, sign } from "node:crypto"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { Review } from "../src/contracts.ts"
import { ask, modelSettings } from "../src/engine.ts"
import type { Request } from "../src/forge/github.ts"
import { keysConfig, keysServer, verifyToken } from "../src/keys.ts"
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

  it("round-trips a review through its marker, and rejects a tampered or quoted one", () => {
    expect(readMarker(`text\n${writeMarker(review)}`)).toEqual(review)
    expect(readMarker(`${writeMarker(review)}\nquoted, then more text`)).toBeNull()
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
    expect(describePull(pull, [], [], [], [{ author: "ana", body: "Wait for Friday." }]).text).toContain("Comments, newest last:\n- ana: Wait for Friday.")
    expect(describePull(pull, [{ path: "b.ts", previous: "a.ts", status: "renamed", additions: 0, deletions: 0, patch: "" }], [], []).text).toContain("### b.ts (renamed from a.ts")
  })

  it("refuses a change GitHub doesn't list whole", async () => {
    const request = (async () => ({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) })) as unknown as Request
    await expect(pullFiles(request, "o/r", "b", HEAD, 301)).rejects.toThrow("listed 300 of the 301")
    expect(await pullFiles(request, "o/r", "b", HEAD, 300)).toHaveLength(300)
  })
})

describe("the engine", () => {
  const schema = z.strictObject({ ok: z.boolean(), line: z.number().int() })
  const answerSchema = { type: "object", properties: { ok: { type: "boolean" }, line: { type: "integer" } }, required: ["ok", "line"], additionalProperties: false }
  const good = JSON.stringify({ ok: true, line: 3 })
  /** A fake fetch that records each call and answers from a list. */
  const recorder = (answers: unknown[]) => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
    const request = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Response(JSON.stringify(answers.shift()))
    }) as unknown as typeof fetch
    return { calls, request }
  }
  const openai = { provider: "openai" as const, baseUrl: "http://m/v1", model: "gpt", key: "k" }
  const anthropic = { provider: "anthropic" as const, baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", key: "a" }

  it("reads each pass's provider, model and effort, the security pass falling back to the review's", () => {
    const env = { TUG_REVIEW_MODEL: "openai/gpt-6.1-sol", TUG_OPENAI_API_KEY: "k" }
    const review = { provider: "openai", baseUrl: "https://api.openai.com/v1", key: "k", model: "gpt-6.1-sol" }
    expect(modelSettings(env)).toEqual({ code: review, security: review })
    expect(modelSettings(env).code).not.toHaveProperty("reasoningEffort")
    const both = { ...env, TUG_REVIEW_REASONING_EFFORT: "high", TUG_SECURITY_MODEL: "anthropic/claude-opus-5-5", TUG_ANTHROPIC_API_KEY: "a", TUG_ANTHROPIC_BASE_URL: "http://proxy/" }
    expect(modelSettings(both)).toEqual({
      code: { ...review, reasoningEffort: "high" },
      security: { provider: "anthropic", baseUrl: "http://proxy", key: "a", model: "claude-opus-5-5", reasoningEffort: "high" },
    })
    expect(modelSettings({ ...both, TUG_SECURITY_REASONING_EFFORT: "max" }).security).toMatchObject({ reasoningEffort: "max" })
    expect(modelSettings({ ...env, TUG_REVIEW_MODEL: "openai/vendor/model:beta", TUG_OPENAI_BASE_URL: "http://p/v1/" }).code).toMatchObject({ baseUrl: "http://p/v1", model: "vendor/model:beta" })
  })

  it("names the setting that is missing or wrong", () => {
    expect(() => modelSettings({})).toThrow("Set TUG_REVIEW_MODEL")
    for (const model of ["gpt-6.1-sol", "google/gemini", "constructor/x", "openai/", "/gpt"]) expect(() => modelSettings({ TUG_REVIEW_MODEL: model, TUG_OPENAI_API_KEY: "k" })).toThrow(`TUG_REVIEW_MODEL must be openai/<model> or anthropic/<model>, not ${model}`)
    expect(() => modelSettings({ TUG_REVIEW_MODEL: "anthropic/claude-opus-5-5", TUG_OPENAI_API_KEY: "k" })).toThrow("Set TUG_ANTHROPIC_API_KEY for anthropic/claude-opus-5-5")
    expect(() => modelSettings({ TUG_REVIEW_MODEL: "anthropic/claude-opus-5-5", TUG_ANTHROPIC_API_KEY: "a", TUG_SECURITY_MODEL: "openai/gpt" })).toThrow("Set TUG_OPENAI_API_KEY for openai/gpt")
    expect(() => modelSettings({ TUG_REVIEW_MODEL: "openai/gpt", TUG_OPENAI_API_KEY: "k", TUG_SECURITY_MODEL: "gpt" })).toThrow("TUG_SECURITY_MODEL must be")
  })

  it("calls OpenAI with a strict JSON schema and the effort only when set, and retries one bad answer", async () => {
    const { calls, request } = recorder([{ choices: [{ message: { content: "not json" } }] }, { choices: [{ message: { content: good } }] }])
    expect(await ask({ settings: { ...openai, reasoningEffort: "high" }, system: "s", user: "u", schema, name: "t", request, retryWaitMs: 0 })).toEqual({ ok: true, line: 3 })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe("http://m/v1/chat/completions")
    expect(calls[0]!.headers).toEqual({ authorization: "Bearer k", "content-type": "application/json" })
    expect(calls[0]!.body).toEqual({
      model: "gpt",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "t", strict: true, schema: answerSchema } },
    })
    const plain = recorder([{ choices: [{ message: { content: good } }] }])
    await ask({ settings: openai, system: "s", user: "u", schema, name: "t", request: plain.request, retryWaitMs: 0 })
    expect(plain.calls[0]!.body).not.toHaveProperty("reasoning_effort")
    await expect(ask({ settings: openai, system: "s", user: "u", schema, name: "t", request: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch, retryWaitMs: 0 })).rejects.toThrow("OpenAI answered 500: nope")
  })

  it("calls Anthropic's Messages API and reads the first text block", async () => {
    const { calls, request } = recorder([{ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: good }] }])
    expect(await ask({ settings: { ...anthropic, reasoningEffort: "xhigh" }, system: "s", user: "u", schema, name: "t", request, retryWaitMs: 0 })).toEqual({ ok: true, line: 3 })
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages")
    expect(calls[0]!.headers).toEqual({ "x-api-key": "a", "anthropic-version": "2023-06-01", "content-type": "application/json" })
    expect(calls[0]!.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      output_config: { format: { type: "json_schema", schema: answerSchema }, effort: "xhigh" },
    })
    const plain = recorder([{ stop_reason: "end_turn", content: [{ type: "text", text: good }] }])
    await ask({ settings: anthropic, system: "s", user: "u", schema, name: "t", request: plain.request, retryWaitMs: 0 })
    expect(plain.calls[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema: answerSchema } })
  })

  it("counts an answer cut off at max_tokens as a failure, and retries it once", async () => {
    const cut = { stop_reason: "max_tokens", content: [{ type: "text", text: '{"ok":' }] }
    const failing = recorder([cut, cut])
    await expect(ask({ settings: anthropic, system: "s", user: "u", schema, name: "t", request: failing.request, retryWaitMs: 0 })).rejects.toThrow("max_tokens")
    expect(failing.calls).toHaveLength(2)
    const recovering = recorder([cut, { stop_reason: "end_turn", content: [{ type: "text", text: good }] }])
    expect(await ask({ settings: anthropic, system: "s", user: "u", schema, name: "t", request: recovering.request, retryWaitMs: 0 })).toEqual({ ok: true, line: 3 })
  })

  it("asks the key service with the job's OIDC token when TUG_KEYS is set and the job has no provider key", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(url.startsWith("https://t/") ? { value: "jwt" } : { content: good }))
    }) as unknown as typeof fetch
    const env = { TUG_KEYS: "http://keys:8787/", ACTIONS_ID_TOKEN_REQUEST_URL: "https://t/?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "b" }
    const settings = modelSettings(env, fake)
    expect(await ask({ settings: settings.security, system: "s", user: "u", schema, name: "t", request: fake, retryWaitMs: 0 })).toEqual({ ok: true, line: 3 })
    expect(calls.map((call) => call.url)).toEqual(["https://t/?x=1&audience=tug", "http://keys:8787/v1/ask"])
    expect(calls[1]!.init!.headers).toMatchObject({ authorization: "Bearer jwt" })
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ pass: "security", system: "s", user: "u", schema: answerSchema, name: "t" })
    expect(modelSettings({ ...env, TUG_REVIEW_MODEL: "openai/gpt", TUG_OPENAI_API_KEY: "k" }).code).toMatchObject({ provider: "openai", key: "k" })
    expect(() => modelSettings({ TUG_KEYS: "http://keys" })).toThrow("id-token: write")
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

  it("reads its settings from the environment", () => {
    expect(keysConfig({ TUG_ACCOUNTS: "g4f4r0, hellogafaro", TUG_REVIEW_MODEL: "anthropic/claude-opus-5-5", TUG_ANTHROPIC_API_KEY: "a" })).toEqual({
      models: { code: { provider: "anthropic", baseUrl: "https://api.anthropic.com", key: "a", model: "claude-opus-5-5" }, security: { provider: "anthropic", baseUrl: "https://api.anthropic.com", key: "a", model: "claude-opus-5-5" } },
      owners: ["g4f4r0", "hellogafaro"],
      workflows: config.workflows,
    })
    expect(() => keysConfig({ TUG_REVIEW_MODEL: "openai/gpt", TUG_OPENAI_API_KEY: "k" })).toThrow("Set TUG_ACCOUNTS")
  })

  it("asks each pass's own provider with its key, model and effort, and refuses the rest", async () => {
    const upstream: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }))
      upstream.push({ url, init })
      if (url.includes("broken")) return new Response("down", { status: 503 })
      const content = JSON.stringify({ ok: true })
      return new Response(JSON.stringify(url.endsWith("/v1/messages") ? { stop_reason: "end_turn", content: [{ type: "text", text: content }] } : { choices: [{ message: { content } }] }))
    }) as unknown as typeof fetch
    const models = {
      code: { provider: "openai" as const, baseUrl: "http://openai/v1", key: "real-openai", model: "gpt-6.1-sol", reasoningEffort: "high" },
      security: { provider: "anthropic" as const, baseUrl: "http://anthropic", key: "real-anthropic", model: "claude-opus-5-5" },
    }
    const server = keysServer({ ...config, models }, { request: fake, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const schema = z.strictObject({ ok: z.boolean() })
    const job = (pass: "code" | "security", token = jwt(claims)) => ask({ settings: { keys: base, pass, token: async () => token }, system: "s", user: "u", schema, name: "t", request: fetch, retryWaitMs: 0 })
    const raw = (body: unknown, path = "/v1/ask") => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${jwt(claims)}` }, body: JSON.stringify(body) })
    try {
      expect(await job("code")).toEqual({ ok: true })
      expect(upstream[0]!.url).toBe("http://openai/v1/chat/completions")
      expect(upstream[0]!.init.headers).toMatchObject({ authorization: "Bearer real-openai" })
      expect(JSON.parse(String(upstream[0]!.init.body))).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "high" })
      expect(await job("security")).toEqual({ ok: true })
      expect(upstream[1]!.url).toBe("http://anthropic/v1/messages")
      expect(upstream[1]!.init.headers).toMatchObject({ "x-api-key": "real-anthropic" })
      expect(JSON.parse(String(upstream[1]!.init.body))).toMatchObject({ model: "claude-opus-5-5", output_config: { format: { type: "json_schema" } } })
      expect(JSON.parse(String(upstream[1]!.init.body)).output_config).not.toHaveProperty("effort")

      const question = { system: "s", user: "u", schema: {}, name: "t" }
      expect((await raw({ ...question, pass: "cheap" })).status).toBe(400)
      expect((await raw({ ...question, pass: "code", model: "cheap" })).status).toBe(400)
      expect((await raw("not an object")).status).toBe(400)
      expect((await raw({ ...question, pass: "code" }, "/v1/chat/completions")).status).toBe(404)
      await expect(job("code", jwt({ ...claims, repository_owner: "x" }))).rejects.toThrow("The key service answered 403")
      expect(upstream).toHaveLength(2)
    } finally {
      server.close()
    }

    const broken = keysServer({ ...config, models: { ...models, code: { ...models.code, baseUrl: "http://broken/v1" } } }, { request: fake, log: () => {} })
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${(broken.address() as AddressInfo).port}/v1/ask`, { method: "POST", headers: { authorization: `Bearer ${jwt(claims)}` }, body: JSON.stringify({ pass: "code", system: "s", user: "u", schema: {}, name: "t" }) })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: { message: "OpenAI answered 503: down" } })
    } finally {
      broken.close()
    }
  })

  const models = { code: { provider: "openai" as const, baseUrl: "http://openai/v1", key: "k", model: "m" }, security: { provider: "openai" as const, baseUrl: "http://openai/v1", key: "k", model: "m" } }
  const question = JSON.stringify({ pass: "code", system: "s", user: "u", schema: {}, name: "t" })
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))
  async function serve(fake: (url: string, init: RequestInit) => Promise<Response>) {
    const server = keysServer({ ...config, models }, { request: fake as unknown as typeof fetch, log: () => {} })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/ask`
    const ask = (token: string, init: RequestInit = {}) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: question, ...init })
    return { ask, close: () => server.close() }
  }

  it("stops the provider call when the job gives up", async () => {
    let started = (): void => {}
    const calling = new Promise<void>((resolve) => (started = resolve))
    let aborted = false
    const keys = await serve(async (url, init) => {
      if (url.endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }))
      started()
      return new Promise<Response>((_, reject) =>
        init.signal!.addEventListener("abort", () => {
          aborted = true
          reject(init.signal!.reason)
        }),
      )
    })
    try {
      const job = new AbortController()
      const asked = keys.ask(jwt(claims), { signal: job.signal }).catch(() => null)
      await calling
      job.abort()
      await asked
      for (let wait = 0; !aborted && wait < 100; wait++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(aborted).toBe(true)
    } finally {
      keys.close()
    }
  })

  it("fetches GitHub's keys again for an unknown key ID, at most once a minute", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 })
    let published = [jwk]
    let fetches = 0
    const keys = await serve(async (url) => {
      if (!url.endsWith("/jwks")) return ok()
      fetches++
      return new Response(JSON.stringify({ keys: published }))
    })
    const clock = vi.spyOn(Date, "now")
    try {
      clock.mockReturnValue(now)
      expect((await keys.ask(jwt(claims))).status).toBe(200)
      const newToken = jwt(claims, { alg: "RS256", kid: "k2" }, rotated.privateKey)
      published = [jwk, { ...rotated.publicKey.export({ format: "jwk" }), kid: "k2" }]
      clock.mockReturnValue(now + 30_000)
      expect((await keys.ask(newToken)).status).toBe(403)
      expect(fetches).toBe(1)
      clock.mockReturnValue(now + 61_000)
      expect((await keys.ask(newToken)).status).toBe(200)
      expect(fetches).toBe(2)
      expect((await keys.ask(jwt(claims, { alg: "RS256", kid: "k3" }))).status).toBe(403)
      expect(fetches).toBe(2)
    } finally {
      clock.mockRestore()
      keys.close()
    }
  })

  it("answers 413 to a body that is too large", async () => {
    const keys = await serve(async (url) => (url.endsWith("/jwks") ? new Response(JSON.stringify({ keys: [jwk] })) : ok()))
    try {
      const response = await keys.ask(jwt(claims), { body: "x".repeat(9_000_000) })
      expect(response.status).toBe(413)
    } finally {
      keys.close()
    }
  })
})

describe("merge", () => {
  const review: Review = { version: 1, head: HEAD, findings: [], risk: "low", merge: true, reason: "Docs only." }
  function github(overrides: { policy?: string | null; review?: Review | null; base?: string; runs?: Record<string, unknown>[]; labels?: string[]; files?: Record<string, unknown>[] } = {}) {
    const calls: string[] = []
    let merged = false
    const request = (async (method: string, path: string) => {
      const route = path.split("?")[0]!
      calls.push(`${method} ${route}`)
      if (method === "GET" && route.endsWith("/pulls/5")) return { state: merged ? "closed" : "open", merged, draft: false, mergeable: true, mergeable_state: "clean", title: "docs: Fix typo", changed_files: (overrides.files ?? [{}]).length, user: { login: "g4f4r0" }, labels: (overrides.labels ?? []).map((name) => ({ name })), head: { sha: HEAD, ref: "docs/typo", repo: { full_name: "g4f4r0/x" } }, base: { ref: "main", sha: "c".repeat(40) } }
      if (route.endsWith("/pulls")) return []
      if (method === "GET" && route.endsWith("/git/refs/heads/docs/typo")) return { object: { sha: HEAD } }
      if (route.endsWith("/actions/runs")) return { workflow_runs: [] }
      if (route.endsWith("/check-runs")) return { check_runs: overrides.runs ?? [{ name: "test", status: "completed", conclusion: "success" }, { name: "merge / squash or hold", status: "in_progress", conclusion: null }] }
      if (route.endsWith("/status")) return { statuses: [] }
      if (route === "/graphql") return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
      if (route.includes("/contents/tug.json")) {
        const policy = overrides.policy === undefined ? JSON.stringify({ merge: { risk: "low" } }) : overrides.policy
        if (policy === null) throw Object.assign(new Error("404"), { status: 404 })
        return { content: Buffer.from(policy).toString("base64") }
      }
      if (route.includes("/compare/")) return { files: (overrides.files ?? [{}]).map((file) => ({ filename: "README.md", status: "modified", additions: 1, deletions: 0, ...file })) }
      if (method === "PUT" && route.endsWith("/merge")) {
        merged = true
        return { merged: true }
      }
      if (method === "POST" || method === "DELETE") return {}
      throw new Error(`unexpected ${method} ${route}`)
    }) as unknown as Request
    return { request, calls }
  }
  const run = (overrides: Parameters<typeof github>[0] = {}) => {
    const t = github(overrides)
    return runMerge({ request: t.request, repo: "g4f4r0/x", number: 5, review: overrides.review === undefined ? review : overrides.review, base: overrides.base, wait: async () => {} }).then((result) => ({ ...result, calls: t.calls }))
  }

  it("merges the exact head by squash, ignoring its own running check, and reads the merge back", async () => {
    const result = await run()
    expect(result).toMatchObject({ merged: true, decision: { action: "merge", reason: "Docs only." } })
    expect(result.calls).toContain("PUT /repos/g4f4r0/x/pulls/5/merge")
    expect(result.calls).toContain("DELETE /repos/g4f4r0/x/git/refs/heads/docs/typo")
  })

  it("holds with needs:human and one comment, or without the run's review", async () => {
    const held = await run({ review: { ...review, merge: false, reason: "Prices change." } })
    expect(held.decision).toEqual({ action: "hold", reason: "Prices change." })
    expect(held.calls.filter((call) => call.startsWith("POST") && !call.endsWith("/graphql"))).toEqual(["POST /repos/g4f4r0/x/labels", "POST /repos/g4f4r0/x/issues/5/labels", "POST /repos/g4f4r0/x/issues/5/comments"])
    expect((await run({ review: null })).decision.action).toBe("hold")
    expect((await run({ labels: ["needs:human"] })).decision.action).toBe("wait")
  })

  it("waits when retargeted after the review, and counts a finished check named merge", async () => {
    expect((await run({ base: "dev" })).decision).toEqual({ action: "wait", reason: "The base changed from dev to main after the review" })
    expect((await run({ runs: [{ name: "other / merge", status: "completed", conclusion: "failure" }] })).decision.action).toBe("wait")
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

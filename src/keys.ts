import { createPublicKey, verify, type JsonWebKey } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { KEYS_AUDIENCE } from "./engine.ts"

const ISSUER = "https://token.actions.githubusercontent.com"

export interface KeysConfig {
  /** The real model API, such as http://127.0.0.1:8317/v1. */
  upstream: string
  key: string
  model: string
  reasoningEffort?: string
  /** Repository owners whose jobs may call, such as g4f4r0. */
  owners: string[]
  /** Workflows that may call, as `job_workflow_ref`, such as hellogafaro/tug/.github/workflows/review.yml@refs/heads/main. */
  workflows: string[]
}

type Claims = Record<string, unknown>
type Jwks = { keys: (JsonWebKey & { kid?: string })[] }

const decode = (part: string): Claims => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Claims

/** Verifies a GitHub Actions OIDC token and returns its claims, or throws why it is refused. */
export async function verifyToken(token: string, config: Pick<KeysConfig, "owners" | "workflows">, jwks: () => Promise<Jwks>, now = Date.now()): Promise<Claims> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("not a JWT")
  const [head, body, signature] = parts as [string, string, string]
  const header = decode(head)
  if (header.alg !== "RS256") throw new Error(`alg ${String(header.alg)}`)
  const jwk = (await jwks()).keys.find((key) => key.kid === header.kid)
  if (!jwk) throw new Error("unknown key")
  if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"))) throw new Error("bad signature")
  const claims = decode(body)
  const seconds = now / 1000
  if (claims.iss !== ISSUER) throw new Error("wrong issuer")
  if (claims.aud !== KEYS_AUDIENCE) throw new Error("wrong audience")
  if (typeof claims.exp !== "number" || claims.exp < seconds) throw new Error("expired")
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) throw new Error("not valid yet")
  if (!config.owners.includes(String(claims.repository_owner))) throw new Error(`owner ${String(claims.repository_owner)} not allowed`)
  if (!config.workflows.includes(String(claims.job_workflow_ref))) throw new Error(`workflow ${String(claims.job_workflow_ref)} not allowed`)
  return claims
}

const readBody = (request: IncomingMessage, limit: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

/**
 * Serves `POST /v1/chat/completions` for GitHub Actions jobs that prove, with their OIDC token, that they run one of
 * the allowed workflows for an allowed owner. It replaces the token with the real key and sets the model and effort,
 * so no runner ever holds them. Everything else is refused.
 */
export function keysServer(config: KeysConfig, options: { request?: typeof fetch; log?: (line: string) => void } = {}): Server {
  const request = options.request ?? fetch
  const log = options.log ?? ((line: string) => console.error(line))
  let cache: { at: number; jwks: Jwks } | undefined
  const jwks = async (): Promise<Jwks> => {
    if (cache && Date.now() - cache.at < 3_600_000) return cache.jwks
    const response = await request(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`JWKS answered ${response.status}`)
    cache = { at: Date.now(), jwks: (await response.json()) as Jwks }
    return cache.jwks
  }
  return createServer(async (incoming, outgoing) => {
    const fail = (status: number, message: string) => {
      outgoing.writeHead(status, { "content-type": "application/json" })
      outgoing.end(JSON.stringify({ error: { message } }))
    }
    try {
      if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") return fail(404, "not found")
      const token = /^Bearer (.+)$/u.exec(incoming.headers.authorization ?? "")?.[1]
      if (!token) return fail(401, "no token")
      let claims: Claims
      try {
        claims = await verifyToken(token, config, jwks)
      } catch (error) {
        log(`refused: ${(error as Error).message}`)
        return fail(403, "refused")
      }
      const body = JSON.parse((await readBody(incoming, 8_000_000)).toString("utf8")) as Record<string, unknown>
      body.model = config.model
      if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort
      else delete body.reasoning_effort
      const upstream = await request(`${config.upstream.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900_000),
      })
      log(`${String(claims.repository)} ${String(claims.job_workflow_ref).split("/").pop()} run ${String(claims.run_id)}: ${upstream.status}`)
      outgoing.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
      outgoing.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      log(`error: ${(error as Error).message}`)
      if (!outgoing.headersSent) fail(502, "upstream failed")
    }
  })
}

/** The key service's settings from its environment. */
export function keysConfig(env: NodeJS.ProcessEnv = process.env): KeysConfig {
  const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/u).filter(Boolean)
  const missing = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "TUG_KEYS_OWNERS", "TUG_KEYS_WORKFLOWS"].filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")}`)
  return { upstream: env.LLM_BASE_URL!, key: env.LLM_API_KEY!, model: env.LLM_MODEL!, reasoningEffort: env.LLM_REASONING_EFFORT || undefined, owners: list(env.TUG_KEYS_OWNERS), workflows: list(env.TUG_KEYS_WORKFLOWS) }
}

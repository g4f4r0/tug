import { createPublicKey, verify, type JsonWebKey } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { KEYS_AUDIENCE, parseModel, type Pass } from "./engine.ts"

const ISSUER = "https://token.actions.githubusercontent.com"
/** The only workflow that may call: Tug's own review, from its main branch. */
const REVIEW_WORKFLOW = "hellogafaro/tug/.github/workflows/review.yml@refs/heads/main"

export interface KeysConfig {
  /** The real model API, such as http://127.0.0.1:8317/v1. */
  upstream: string
  key: string
  /** Each pass's model and effort. */
  models: Record<Pass, { model: string; reasoningEffort?: string }>
  /** Accounts whose repositories' jobs may call, such as g4f4r0. */
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
  if (!config.owners.some((owner) => owner.toLowerCase() === String(claims.repository_owner).toLowerCase())) throw new Error(`owner ${String(claims.repository_owner)} not allowed`)
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
 * the allowed workflows for an allowed owner. It replaces the token with the real key and sets the model and effort of
 * the pass the request names as its model (`code` or `security`), so no runner ever holds them or picks another model.
 * Everything else is refused.
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
      const chosen = config.models[body.model === "security" ? "security" : "code"]
      body.model = chosen.model
      if (chosen.reasoningEffort) body.reasoning_effort = chosen.reasoningEffort
      else delete body.reasoning_effort
      const upstream = await request(`${config.upstream.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900_000),
      })
      log(`${String(claims.repository)} ${String(claims.job_workflow_ref).replace(/^.*\/workflows\//u, "")} run ${String(claims.run_id)}: ${upstream.status}`)
      outgoing.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
      outgoing.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      log(`error: ${(error as Error).message}`)
      if (!outgoing.headersSent) fail(502, "upstream failed")
    }
  })
}

/** The key service's settings from its environment, named as in `modelSettings`, plus `TUG_ACCOUNTS`. */
export function keysConfig(env: NodeJS.ProcessEnv = process.env): KeysConfig {
  const missing = ["TUG_MODEL_URL", "TUG_MODEL_KEY", "TUG_REVIEW_MODEL", "TUG_ACCOUNTS"].filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")}`)
  const review = parseModel(env.TUG_REVIEW_MODEL!)
  return {
    upstream: env.TUG_MODEL_URL!,
    key: env.TUG_MODEL_KEY!,
    models: { code: review, security: env.TUG_SECURITY_MODEL ? parseModel(env.TUG_SECURITY_MODEL) : review },
    owners: env.TUG_ACCOUNTS!.split(/[\s,]+/u).filter(Boolean),
    workflows: [REVIEW_WORKFLOW],
  }
}

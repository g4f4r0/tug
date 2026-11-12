import { createPublicKey, verify, type JsonWebKey } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { z } from "zod"
import { callProvider, KEYS_AUDIENCE, PASSES, providerSettings, type ModelSettings, type Pass } from "./engine.ts"

const ISSUER = "https://token.actions.githubusercontent.com"
/** The only workflow that may call: Tug's own review, from its main branch. */
const REVIEW_WORKFLOW = "hellogafaro/tug/.github/workflows/review.yml@refs/heads/main"

export interface KeysConfig {
  /** Each pass's provider, model, effort and key. */
  models: Record<Pass, ModelSettings>
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

/** What a job asks: the pass, and the question for its model. */
const AskBody = z.strictObject({ pass: z.enum(PASSES), system: z.string(), user: z.string(), schema: z.record(z.string(), z.unknown()), name: z.string() })

/**
 * Serves `POST /v1/ask` for GitHub Actions jobs that prove, with their OIDC token, that they run one of the allowed
 * workflows for an allowed owner. It calls the provider of the pass the request names (`code` or `security`) with its
 * own key, model and effort, so no runner ever holds them or picks another model, and returns the model's JSON text
 * as `content`. Everything else is refused.
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
    const reply = (status: number, body: unknown) => {
      outgoing.writeHead(status, { "content-type": "application/json" })
      outgoing.end(JSON.stringify(body))
    }
    const fail = (status: number, message: string) => reply(status, { error: { message } })
    try {
      if (incoming.method !== "POST" || incoming.url !== "/v1/ask") return fail(404, "not found")
      const token = /^Bearer (.+)$/u.exec(incoming.headers.authorization ?? "")?.[1]
      if (!token) return fail(401, "no token")
      let claims: Claims
      try {
        claims = await verifyToken(token, config, jwks)
      } catch (error) {
        log(`refused: ${(error as Error).message}`)
        return fail(403, "refused")
      }
      const text = (await readBody(incoming, 8_000_000)).toString("utf8")
      let body: z.infer<typeof AskBody>
      try {
        body = AskBody.parse(JSON.parse(text))
      } catch {
        return fail(400, "expected { pass: code or security, system, user, schema, name }")
      }
      const caller = `${String(claims.repository)} ${String(claims.job_workflow_ref).replace(/^.*\/workflows\//u, "")} run ${String(claims.run_id)} ${body.pass}`
      const { pass, ...question } = body
      let content: string
      try {
        content = await callProvider(config.models[pass], question, request)
      } catch (error) {
        log(`${caller}: ${(error as Error).message}`)
        return fail(502, (error as Error).message)
      }
      log(`${caller}: ok`)
      reply(200, { content })
    } catch (error) {
      log(`error: ${(error as Error).message}`)
      if (!outgoing.headersSent) fail(502, "upstream failed")
    }
  })
}

/** The key service's settings from its environment, named as in `providerSettings`, plus `TUG_ACCOUNTS`. */
export function keysConfig(env: NodeJS.ProcessEnv = process.env): KeysConfig {
  if (!env.TUG_ACCOUNTS) throw new Error("Set TUG_ACCOUNTS")
  return {
    models: providerSettings(env),
    owners: env.TUG_ACCOUNTS.split(/[\s,]+/u).filter(Boolean),
    workflows: [REVIEW_WORKFLOW],
  }
}

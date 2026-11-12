import type { z } from "zod"
import { toJSONSchema } from "zod"

/** The audience of the GitHub OIDC token a Tug key service accepts. */
export const KEYS_AUDIENCE = "tug"

/** The review's two passes, each with its own model. */
export const PASSES = ["code", "security"] as const
export type Pass = (typeof PASSES)[number]

/** Each provider's settings: its key, its base URL and that URL's default. */
const PROVIDERS = {
  openai: { key: "TUG_OPENAI_API_KEY", baseUrl: "TUG_OPENAI_BASE_URL", default: "https://api.openai.com/v1" },
  anthropic: { key: "TUG_ANTHROPIC_API_KEY", baseUrl: "TUG_ANTHROPIC_BASE_URL", default: "https://api.anthropic.com" },
} as const
type Provider = keyof typeof PROVIDERS

export interface ModelSettings {
  provider: Provider
  baseUrl: string
  key: string
  model: string
  reasoningEffort?: string
}

/** A pass's calls go to a provider, or to a Tug key service that holds the provider settings. */
export type PassSettings = ModelSettings | { keys: string; pass: Pass; token: () => Promise<string> }

/** What a provider call gets: the prompts and the JSON schema the answer must match. */
export interface Question {
  system: string
  user: string
  schema: Record<string, unknown>
  name: string
}

/** One pass's provider settings from a `<provider>/<model>` value; the model may itself contain `/`. */
function settingsFor(env: NodeJS.ProcessEnv, setting: string, value: string | undefined, reasoningEffort: string | undefined): ModelSettings {
  if (!value) throw new Error(`Set ${setting}`)
  const at = value.indexOf("/")
  const provider = value.slice(0, at)
  if (at < 0 || !value.slice(at + 1) || !Object.hasOwn(PROVIDERS, provider)) throw new Error(`${setting} must be openai/<model> or anthropic/<model>, not ${value}`)
  const names = PROVIDERS[provider as Provider]
  const key = env[names.key]
  if (!key) throw new Error(`Set ${names.key} for ${value}`)
  const baseUrl = (env[names.baseUrl] || names.default).replace(/\/$/u, "")
  return { provider: provider as Provider, baseUrl, key, model: value.slice(at + 1), ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/**
 * Each pass's provider settings: `TUG_REVIEW_MODEL`, such as `openai/gpt-6.1-sol`, and `TUG_REVIEW_REASONING_EFFORT`,
 * with the provider's `TUG_<PROVIDER>_API_KEY` and `TUG_<PROVIDER>_BASE_URL`. The security pass uses
 * `TUG_SECURITY_MODEL` and `TUG_SECURITY_REASONING_EFFORT`, each falling back to the review's. Without an effort, the
 * provider's default applies.
 */
export function providerSettings(env: NodeJS.ProcessEnv = process.env): Record<Pass, ModelSettings> {
  return {
    code: settingsFor(env, "TUG_REVIEW_MODEL", env.TUG_REVIEW_MODEL, env.TUG_REVIEW_REASONING_EFFORT),
    security: settingsFor(env, env.TUG_SECURITY_MODEL ? "TUG_SECURITY_MODEL" : "TUG_REVIEW_MODEL", env.TUG_SECURITY_MODEL || env.TUG_REVIEW_MODEL, env.TUG_SECURITY_REASONING_EFFORT || env.TUG_REVIEW_REASONING_EFFORT),
  }
}

/**
 * The job's settings: the provider settings, or, on a runner that sets `TUG_KEYS` (the URL of a Tug key service) and
 * gives the job no provider key, the key service, called with the job's GitHub OIDC token and naming only the pass.
 */
export function modelSettings(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Record<Pass, PassSettings> {
  if (!env.TUG_KEYS || env.TUG_OPENAI_API_KEY || env.TUG_ANTHROPIC_API_KEY) return providerSettings(env)
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) throw new Error("TUG_KEYS is set, but the job has no OIDC token: grant it `id-token: write`")
  const keys = env.TUG_KEYS.replace(/\/$/u, "")
  const token = async () => {
    const response = await request(`${url}&audience=${KEYS_AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to the OIDC token request`)
    const value = ((await response.json()) as { value?: unknown }).value
    if (typeof value !== "string") throw new Error("GitHub returned no OIDC token")
    return value
  }
  return { code: { keys, pass: "code", token }, security: { keys, pass: "security", token } }
}

/** POSTs JSON and returns the parsed answer, or throws with the status and the start of the body. */
async function post(request: typeof fetch, who: string, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${who} answered ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** A chat-completions call with a strict JSON schema; returns the answer's text. */
async function openai(settings: ModelSettings, question: Question, request: typeof fetch, timeoutMs: number): Promise<string> {
  const body = {
    model: settings.model,
    ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
    messages: [
      { role: "system", content: question.system },
      { role: "user", content: question.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: question.name, strict: true, schema: question.schema } },
  }
  const answer = (await post(request, "OpenAI", `${settings.baseUrl}/chat/completions`, { authorization: `Bearer ${settings.key}` }, body, timeoutMs)) as { choices?: { message?: { content?: unknown } }[] }
  const content = answer.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("OpenAI returned no content")
  return content
}

/** A Messages API call with a JSON schema output format; returns the first text block. */
async function anthropic(settings: ModelSettings, question: Question, request: typeof fetch, timeoutMs: number): Promise<string> {
  const body = {
    model: settings.model,
    max_tokens: 64_000,
    system: question.system,
    messages: [{ role: "user", content: question.user }],
    output_config: { format: { type: "json_schema", schema: question.schema }, ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}) },
  }
  const headers = { "x-api-key": settings.key, "anthropic-version": "2023-06-01" }
  const answer = (await post(request, "Anthropic", `${settings.baseUrl}/v1/messages`, headers, body, timeoutMs)) as { stop_reason?: unknown; content?: { type?: unknown; text?: unknown }[] }
  if (answer.stop_reason === "max_tokens") throw new Error("Anthropic stopped at max_tokens before the answer was complete")
  const text = answer.content?.find((block) => block.type === "text")?.text
  if (typeof text !== "string") throw new Error("Anthropic returned no text")
  return text
}

/** One call to the settings' provider; returns the model's JSON text. */
export function callProvider(settings: ModelSettings, question: Question, request: typeof fetch = fetch, timeoutMs = 900_000): Promise<string> {
  return (settings.provider === "anthropic" ? anthropic : openai)(settings, question, request, timeoutMs)
}

/** One call through the key service, which picks the pass's provider, model and effort; returns the model's JSON text. */
async function viaKeys(settings: Extract<PassSettings, { keys: string }>, question: Question, request: typeof fetch, timeoutMs: number): Promise<string> {
  const answer = (await post(request, "The key service", `${settings.keys}/v1/ask`, { authorization: `Bearer ${await settings.token()}` }, { pass: settings.pass, ...question }, timeoutMs)) as { content?: unknown }
  if (typeof answer.content !== "string") throw new Error("The key service returned no content")
  return answer.content
}

/** Keywords Anthropic's structured outputs refuse, such as the safe-integer bounds zod gives `.int()`; zod still checks them. */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"]

/** The JSON schema both providers accept for `schema`. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = toJSONSchema(schema, { target: "draft-7", override: ({ jsonSchema }) => UNSUPPORTED.forEach((keyword) => delete (jsonSchema as Record<string, unknown>)[keyword]) }) as Record<string, unknown>
  delete json.$schema
  return json
}

/**
 * One model call whose answer must match `schema`, to the provider or through the key service. A failed call or an
 * answer that doesn't match is retried once, after `retryWaitMs` so a restarting model service is back, then thrown:
 * the caller fails closed.
 */
export async function ask<T extends z.ZodType>(input: { settings: PassSettings; system: string; user: string; schema: T; name: string; request?: typeof fetch; timeoutMs?: number; retryWaitMs?: number }): Promise<z.infer<T>> {
  const { settings, schema } = input
  const request = input.request ?? fetch
  const timeoutMs = input.timeoutMs ?? 900_000
  const question: Question = { system: input.system, user: input.user, schema: jsonSchema(schema), name: input.name }
  let last: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, input.retryWaitMs ?? 30_000))
    try {
      const content = "keys" in settings ? await viaKeys(settings, question, request, timeoutMs) : await callProvider(settings, question, request, timeoutMs)
      return schema.parse(JSON.parse(content))
    } catch (error) {
      last = error
    }
  }
  throw last
}

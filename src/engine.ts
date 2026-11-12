import type { z } from "zod"
import { toJSONSchema } from "zod"

/** The audience of the GitHub OIDC token a Tug key service accepts. */
export const KEYS_AUDIENCE = "tug"

export interface ModelSettings {
  baseUrl: string
  model: string
  /** A static key, or a function that fetches one per call, such as a fresh GitHub OIDC token. */
  key: string | (() => Promise<string>)
  reasoningEffort?: string
}

/**
 * Reads the model settings: `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`, plus an optional `LLM_REASONING_EFFORT`.
 * On a runner that sets `TUG_KEYS`, the URL of a Tug key service, calls go there with the job's GitHub OIDC token
 * instead, and the service adds the real key, model and effort.
 */
export function modelSettings(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): ModelSettings {
  if (env.TUG_KEYS && !env.LLM_API_KEY) {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!url || !bearer) throw new Error("TUG_KEYS is set, but the job has no OIDC token: grant it `id-token: write`")
    return {
      baseUrl: `${env.TUG_KEYS.replace(/\/$/u, "")}/v1`,
      model: env.LLM_MODEL || "default",
      key: async () => {
        const response = await request(`${url}&audience=${KEYS_AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`GitHub answered ${response.status} to the OIDC token request`)
        const value = ((await response.json()) as { value?: unknown }).value
        if (typeof value !== "string") throw new Error("GitHub returned no OIDC token")
        return value
      },
    }
  }
  const missing = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"].filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")}`)
  return { baseUrl: env.LLM_BASE_URL!.replace(/\/$/u, ""), model: env.LLM_MODEL!, key: env.LLM_API_KEY!, reasoningEffort: env.LLM_REASONING_EFFORT || undefined }
}

/**
 * One chat-completions call whose answer must match `schema`. A failed call or an answer that doesn't match is
 * retried once, then thrown: the caller fails closed.
 */
export async function ask<T extends z.ZodType>(input: { settings: ModelSettings; system: string; user: string; schema: T; name: string; request?: typeof fetch; timeoutMs?: number }): Promise<z.infer<T>> {
  const { settings, schema } = input
  const request = input.request ?? fetch
  const jsonSchema = toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
  delete jsonSchema.$schema
  let last: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const key = typeof settings.key === "string" ? settings.key : await settings.key()
      const response = await request(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: settings.model,
          ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: input.name, strict: true, schema: jsonSchema } },
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 900_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`The model API answered ${response.status}: ${text.slice(0, 300)}`)
      const content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
      if (typeof content !== "string") throw new Error("The model returned no content")
      return schema.parse(JSON.parse(content))
    } catch (error) {
      last = error
    }
  }
  throw last
}

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import type { Image } from "./engine.ts"
import type { PullComment, PullFile } from "./forge/github.ts"
import { MAX_IMAGES } from "./keys.ts"

/** Media read per pull request, from its body, its comments and its changed files, in that order. */
const MAX_MEDIA = 10
/** Frames a video is shown as, evenly spread over it. */
const FRAMES = 6
/** The largest file read: a video, or an image before it is scaled down. */
const MAX_DOWNLOAD = 50_000_000
/** The largest image a model gets; a bigger one is scaled down, as both providers refuse more. */
const MAX_IMAGE = 3_500_000
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/iu

/**
 * A static ffmpeg for runners that lack one, such as Tug's own, from a pinned release and checked against its SHA-256
 * before it runs. GitHub's runners have ffmpeg on PATH, which is used instead.
 */
const FFMPEG: Record<string, { url: string; sha256: string }> = {
  x64: { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64.gz", sha256: "17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f" },
  arm64: { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-arm64.gz", sha256: "2b708b2d15041d2a192c1db24c7a8a1d24f645a8242dce1c744ff2392b86ada1" },
}

/** Where a pull request shows a piece of media: a URL in its text, or a file it changes. */
export interface MediaRef {
  source: string
  url?: string
  path?: string
  alt?: string
}

/** The media a review looks at: the images in the order the model gets them, and the lines that name them. */
export interface Media {
  images: Image[]
  lines: string[]
}

export interface MediaOptions {
  /** The token that reads the repository, for files and GitHub's uploads; it goes to GitHub only. */
  token: string
  api?: string
  fetch?: typeof fetch
  /** ffmpeg to use; found on PATH, else downloaded, when absent. Tests set it. */
  ffmpeg?: string
  /** Gets each line naming the media, as the model reads it, such as for the job's log. */
  log?: (line: string) => void
}

const run = promisify(execFile)

/** The media a pull request's body, comments (not bots') and changed files show, each once, in that order. */
export function mediaRefs(body: string, comments: PullComment[], files: PullFile[]): MediaRef[] {
  const refs: MediaRef[] = []
  const seen = new Set<string>()
  const add = (ref: MediaRef) => {
    const key = ref.url ?? `file:${ref.path}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }
  const scan = (text: string, source: string) => {
    const found: { at: number; url: string; alt?: string }[] = []
    for (const match of text.matchAll(/!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) found.push({ at: match.index, url: match[2]!, alt: match[1] || undefined })
    for (const match of text.matchAll(/<(?:img|video|source)\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/giu)) {
      const alt = /\balt\s*=\s*["']([^"']*)["']/iu.exec(match[0])?.[1]
      found.push({ at: match.index, url: match[1]!, alt: alt || undefined })
    }
    // GitHub shows an uploaded file pasted on its own line, a video above all, with no markup around it.
    for (const match of text.matchAll(/^[ \t]*(https:\/\/github\.com\/user-attachments\/(?:assets|files)\/\S+|https:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|m4v|webm))[ \t]*$/gimu)) found.push({ at: match.index, url: match[1]! })
    for (const item of found.sort((a, b) => a.at - b.at)) add({ source, url: item.url, ...(item.alt ? { alt: item.alt } : {}) })
  }
  scan(body, "the body")
  for (const comment of comments) if (!comment.author.endsWith("[bot]")) scan(comment.body, `a comment by ${comment.author}`)
  // A link to a changed file, such as github.com/o/r/blob/<branch>/<path>, is read once, as the file at the head: a
  // branch with a slash in its name makes such a link ambiguous, and the head is what the review reviews.
  const linking = (path: string) =>
    refs.find((ref) => {
      try {
        return ref.url !== undefined && ref.path === undefined && decodeURIComponent(new URL(ref.url).pathname).endsWith(`/${path}`)
      } catch {
        // A malformed link links to nothing.
        return false
      }
    })
  for (const file of files) {
    if (file.status === "removed" || !MEDIA_FILE.test(file.path)) continue
    const link = linking(file.path)
    if (link) link.path = file.path
    else add({ source: `the changed file ${file.path}`, path: file.path })
  }
  return refs
}

/** What the bytes are, whatever their name or header says; null for anything else. */
export function sniff(bytes: Buffer): { kind: "image"; mediaType: Image["mediaType"] } | { kind: "video" } | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1")
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mediaType: "image/png" }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mediaType: "image/jpeg" }
  if (ascii(0, 4) === "GIF8") return { kind: "image", mediaType: "image/gif" }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { kind: "image", mediaType: "image/webp" }
  if (ascii(4, 8) === "ftyp") return { kind: "video" }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: "video" }
  return null
}

class MediaError extends Error {}

/** A response's body, up to `limit` bytes; past it, the read stops and fails. */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel()
    throw new MediaError(`it is larger than ${limit / 1_000_000} MB`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) throw new MediaError(`it is larger than ${limit / 1_000_000} MB`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** A file of a GitHub repository at a ref, through the contents API, with the token. */
function contentsUrl(api: string, repo: string, path: string, ref: string): string {
  return `${api}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
}

/**
 * Downloads one piece of media. Files and GitHub URLs of a repository are read through the contents API, uploads to
 * GitHub with the token; any other host gets no token, and every redirect is followed without one and only to https.
 */
async function download(ref: MediaRef, repo: string, head: string, options: MediaOptions): Promise<Buffer> {
  const call = options.fetch ?? fetch
  const api = (options.api ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "")
  const authorized = { authorization: `Bearer ${options.token}`, "user-agent": "tug" }
  const get = async (url: string, headers: Record<string, string>): Promise<Buffer> => {
    let target = new URL(url)
    let send = headers
    for (let hop = 0; hop < 4; hop++) {
      if (target.protocol !== "https:") throw new MediaError("it is not served over https")
      const response = await call(target, { headers: send, redirect: "manual", signal: AbortSignal.timeout(60_000) })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel()
        target = new URL(location, target)
        // A redirect leaves for a signed storage URL or another host: the token never goes along.
        send = { "user-agent": "tug" }
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new MediaError(`it answered ${response.status}`)
      }
      return readCapped(response, MAX_DOWNLOAD)
    }
    throw new MediaError("it redirects too often")
  }
  const raw = { ...authorized, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" }
  if (ref.path) return get(contentsUrl(api, repo, ref.path, head), raw)
  const url = new URL(ref.url!)
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  if (url.protocol !== "https:") throw new MediaError("it is not served over https")
  // <ref>/<path> in a repository URL is ambiguous when the ref has a slash, as feat/x does: each split is tried, the
  // shortest ref first, until one is a file.
  const inRepo = async (owner: string, name: string, rest: string[]): Promise<Buffer> => {
    let last: unknown
    for (let cut = 1; cut < rest.length && cut <= 5; cut++) {
      try {
        return await get(contentsUrl(api, `${owner}/${name}`, rest.slice(cut).join("/"), rest.slice(0, cut).join("/")), raw)
      } catch (error) {
        last = error
        if (!(error instanceof MediaError) || error.message !== "it answered 404") throw error
      }
    }
    throw last ?? new MediaError("it names no file")
  }
  // github.com/<owner>/<repo>/blob|raw/<ref>/<path>, and raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.
  if (url.hostname === "github.com" && parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) return inRepo(parts[0]!, parts[1]!, parts.slice(3))
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) return inRepo(parts[0]!, parts[1]!, parts.slice(2))
  if (url.hostname === "github.com" && parts[0] === "user-attachments") return get(url.href, authorized)
  return get(url.href, { "user-agent": "tug" })
}

/** ffmpeg: the one given, one on PATH, or the pinned static build, downloaded into `dir` and checked. */
async function findFfmpeg(dir: string, options: MediaOptions): Promise<string> {
  if (options.ffmpeg) return options.ffmpeg
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, "ffmpeg")
    try {
      await access(candidate, 1)
      return candidate
    } catch {
      // Not in this folder.
    }
  }
  const build = FFMPEG[process.arch]
  if (process.platform !== "linux" || !build) throw new MediaError(`no ffmpeg for ${process.platform} ${process.arch}`)
  const response = await (options.fetch ?? fetch)(build.url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new MediaError(`ffmpeg's download answered ${response.status}`)
  const packed = Buffer.from(await response.arrayBuffer())
  if (createHash("sha256").update(packed).digest("hex") !== build.sha256) throw new MediaError("ffmpeg's download does not match its checksum")
  const path = join(dir, "ffmpeg")
  await writeFile(path, gunzipSync(packed))
  await chmod(path, 0o755)
  return path
}

/** Runs ffmpeg on untrusted media: no environment, so no token or key can reach it, a time limit, and no stdin. */
async function ffmpeg(binary: string, args: string[]): Promise<{ stderr: string }> {
  try {
    const { stderr } = await run(binary, ["-hide_banner", "-nostdin", ...args], { env: {}, timeout: 60_000, maxBuffer: 4_000_000 })
    return { stderr: String(stderr) }
  } catch (error) {
    const failed = error as { stderr?: unknown; killed?: boolean }
    if (failed.killed) throw new MediaError("ffmpeg took too long")
    return { stderr: String(failed.stderr ?? "") }
  }
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`)

/** Up to `count` frames of a video, evenly spread over it, as JPEGs no wider than 1280 pixels. */
async function frames(binary: string, video: string, dir: string, count: number): Promise<{ at: number; image: Image }[]> {
  const probe = await ffmpeg(binary, ["-i", video])
  const parts = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(probe.stderr)
  const duration = parts ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) : 0
  const times = duration >= 1 ? Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count) : [0]
  const shots: { at: number; image: Image }[] = []
  for (const [index, at] of times.entries()) {
    const out = join(dir, `${video.split("/").at(-1)}-${index}.jpg`)
    await ffmpeg(binary, ["-ss", at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "5", "-y", out])
    try {
      shots.push({ at, image: { mediaType: "image/jpeg", data: (await readFile(out)).toString("base64") } })
    } catch {
      // No frame at that time; the others still show the video.
    }
  }
  if (shots.length === 0) throw new MediaError("ffmpeg could not read a frame from it")
  return shots
}

/** An image no larger than MAX_IMAGE: as it is, or scaled down to a JPEG no wider than 1600 pixels. */
async function fit(binary: () => Promise<string>, bytes: Buffer, mediaType: Image["mediaType"], dir: string, name: string): Promise<Image> {
  if (bytes.length <= MAX_IMAGE) return { mediaType, data: bytes.toString("base64") }
  const input = join(dir, name)
  const out = join(dir, `${name}.jpg`)
  await writeFile(input, bytes)
  await ffmpeg(await binary(), ["-i", input, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", "-q:v", "5", "-y", out])
  const scaled = await readFile(out).catch(() => null)
  if (!scaled || scaled.length > MAX_IMAGE) throw new MediaError("it is too large to show, even scaled down")
  return { mediaType: "image/jpeg", data: scaled.toString("base64") }
}

const describe = (ref: MediaRef) => `${ref.source}${ref.alt ? `, "${ref.alt.slice(0, 120)}"` : ""}${ref.url ? `, ${ref.url.slice(0, 200)}` : ""}`

/**
 * Reads the media the pull request shows into a fresh temporary folder, hands it to `use`, and removes the folder
 * and everything in it, ffmpeg included, however `use` ends. Media that can't be read is named, with why, so the
 * review knows it saw no such evidence.
 */
export async function withMedia<T>(input: { repo: string; head: string; refs: MediaRef[]; options: MediaOptions }, use: (media: Media) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "tug-media-"))
  try {
    const images: Image[] = []
    const lines: string[] = []
    let ffmpegPath: Promise<string> | undefined
    const binary = () => (ffmpegPath ??= findFfmpeg(dir, input.options))
    for (const [index, ref] of input.refs.slice(0, MAX_MEDIA).entries()) {
      const label = `media ${index + 1}`
      const room = MAX_IMAGES - images.length
      if (room <= 0) {
        lines.push(`${label}: from ${describe(ref)}, left out: the review shows at most ${MAX_IMAGES} images`)
        continue
      }
      try {
        const bytes = await download(ref, input.repo, input.head, input.options)
        const kind = sniff(bytes)
        if (!kind) throw new MediaError("it is not an image or a video Tug reads (PNG, JPEG, GIF, WebP, MP4, MOV, WebM)")
        if (kind.kind === "image") {
          images.push(await fit(binary, bytes, kind.mediaType, dir, `${index}`))
          lines.push(`${label}: image (${kind.mediaType.slice(6).toUpperCase()}, ${size(bytes.length)}) from ${describe(ref)}`)
        } else {
          const video = join(dir, `video-${index}`)
          await writeFile(video, bytes)
          const shots = await frames(await binary(), video, dir, Math.min(FRAMES, room))
          images.push(...shots.map((shot) => shot.image))
          lines.push(`${label}: video (${size(bytes.length)}) from ${describe(ref)}, shown as ${shots.length} frames, at ${shots.map((shot) => clock(shot.at)).join(", ")}`)
        }
      } catch (error) {
        const why = error instanceof MediaError ? error.message : "it could not be read"
        lines.push(`${label}: from ${describe(ref)}, could not be read: ${why}. Judge the change without it.`)
      }
    }
    if (input.refs.length > MAX_MEDIA) lines.push(`${input.refs.length - MAX_MEDIA} more media left out: the review reads at most ${MAX_MEDIA}.`)
    for (const line of lines) input.options.log?.(line)
    return await use({ images, lines })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

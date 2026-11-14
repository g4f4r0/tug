import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mediaRefs, sniff, withMedia, type Media, type MediaOptions, type MediaRef } from "../src/media.ts"

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

/** ffmpeg for the tests that run it: on PATH, as CI installs it, or TUG_TEST_FFMPEG. */
const FFMPEG = process.env.TUG_TEST_FFMPEG || (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "ffmpeg")).find((path) => existsSync(path))

/** A fetch that answers by URL and records each request's URL and headers. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string>; redirect?: string }[] = []
  const call = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect })
    return answer(url)
  }) as unknown as typeof fetch
  return { call, calls }
}

async function read(refs: MediaRef[], options: Partial<MediaOptions> & { fetch: typeof fetch }): Promise<Media> {
  return withMedia({ repo: "o/r", head: "abc123", refs, options: { token: "ghs_secret", api: "https://api.github.com", ...options } }, async (media) => media)
}

describe("finding media", () => {
  it("finds images and videos in the body, people's comments and changed files, each once, in that order", () => {
    const body = [
      'Before: ![the old page](https://example.com/old.png "old")',
      '<img width="600" alt="after saving" src="https://github.com/user-attachments/assets/1111-2222" />',
      "https://github.com/user-attachments/assets/3333-4444",
      "<video src='https://cdn.example.com/flow.mp4'></video>",
      "A link to the docs: https://example.com/guide and [a page](https://example.com/page.html)",
      "![again](https://example.com/old.png)",
    ].join("\n")
    const comments = [
      { author: "alice", body: "Fixed: ![now](https://example.com/now.webp)" },
      { author: "github-actions[bot]", body: "![bot image](https://example.com/bot.png)" },
    ]
    const files = [
      { path: "public/hero.jpg", status: "added", additions: 0, deletions: 0 },
      { path: "public/old.gif", status: "removed", additions: 0, deletions: 0 },
      { path: "src/app.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" },
    ]
    expect(mediaRefs(body, comments, files)).toEqual([
      { source: "the body", url: "https://example.com/old.png", alt: "the old page" },
      { source: "the body", url: "https://github.com/user-attachments/assets/1111-2222", alt: "after saving" },
      { source: "the body", url: "https://github.com/user-attachments/assets/3333-4444" },
      { source: "the body", url: "https://cdn.example.com/flow.mp4" },
      { source: "a comment by alice", url: "https://example.com/now.webp", alt: "now" },
      { source: "the changed file public/hero.jpg", path: "public/hero.jpg" },
    ])
  })

  it("reads a changed file the text links to once, as the file at the head, whatever the branch is called", () => {
    const files = [
      { path: "evidence/flow.mp4", status: "added", additions: 0, deletions: 0 },
      { path: "evidence/after.png", status: "added", additions: 0, deletions: 0 },
    ]
    expect(mediaRefs("The flow:\nhttps://github.com/o/r/blob/feat/x/evidence/flow.mp4", [], files)).toEqual([
      { source: "the body", url: "https://github.com/o/r/blob/feat/x/evidence/flow.mp4", path: "evidence/flow.mp4" },
      { source: "the changed file evidence/after.png", path: "evidence/after.png" },
    ])
  })

  it("knows images and videos by their bytes, not their names", () => {
    expect(sniff(PNG)).toEqual({ kind: "image", mediaType: "image/png" })
    expect(sniff(JPEG)).toEqual({ kind: "image", mediaType: "image/jpeg" })
    expect(sniff(Buffer.from("GIF89a..."))).toEqual({ kind: "image", mediaType: "image/gif" })
    expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ kind: "image", mediaType: "image/webp" })
    expect(sniff(Buffer.from("\0\0\0\x18ftypmp42"))).toEqual({ kind: "video" })
    expect(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toEqual({ kind: "video" })
    expect(sniff(Buffer.from("<html>not an image</html>"))).toBeNull()
  })
})

describe("reading media", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("sends the token to GitHub only, and never along a redirect", async () => {
    const { call, calls } = fakeFetch((url) => {
      if (url === "https://github.com/user-attachments/assets/1111") return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/signed?X-Amz=1" } })
      return new Response(PNG)
    })
    const media = await read(
      [
        { source: "the body", url: "https://github.com/user-attachments/assets/1111" },
        { source: "the body", url: "https://images.example.com/shot.png" },
        { source: "the body", url: "https://github.com/o/r/blob/feature/docs/shot.png?raw=true" },
        { source: "the changed file public/a b.png", path: "public/a b.png" },
      ],
      { fetch: call },
    )
    expect(media.images).toHaveLength(4)
    const auth = (url: string) => calls.find((c) => c.url === url)?.headers.authorization
    expect(auth("https://github.com/user-attachments/assets/1111")).toBe("Bearer ghs_secret")
    expect(auth("https://objects.githubusercontent.com/signed?X-Amz=1")).toBeUndefined()
    expect(auth("https://images.example.com/shot.png")).toBeUndefined()
    // Files, and repository URLs, go through the contents API, at the head or the URL's ref.
    expect(calls.map((c) => c.url)).toContain("https://api.github.com/repos/o/r/contents/docs/shot.png?ref=feature")
    expect(calls.map((c) => c.url)).toContain("https://api.github.com/repos/o/r/contents/public/a%20b.png?ref=abc123")
    expect(calls.filter((c) => c.url.startsWith("https://api.github.com/")).every((c) => c.headers.authorization === "Bearer ghs_secret" && c.headers.accept === "application/vnd.github.raw")).toBe(true)
    expect(calls.every((c) => c.redirect === "manual")).toBe(true)
    expect(media.lines[0]).toBe("media 1: image (PNG, 1 KB) from the body, https://github.com/user-attachments/assets/1111")
  })

  it("finds the file a repository link names when its branch has a slash, trying each split", async () => {
    const { call, calls } = fakeFetch((url) => (url === "https://api.github.com/repos/o/other/contents/shots/a.png?ref=feat%2Fx" ? new Response(PNG) : new Response("Not Found", { status: 404 })))
    const lines: string[] = []
    const media = await read([{ source: "the body", url: "https://github.com/o/other/blob/feat/x/shots/a.png?raw=true" }], { fetch: call, log: (line) => lines.push(line) })
    expect(media.images).toHaveLength(1)
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/o/other/contents/x/shots/a.png?ref=feat", "https://api.github.com/repos/o/other/contents/shots/a.png?ref=feat%2Fx"])
    expect(lines).toEqual(media.lines)
  })

  it("names what it couldn't read, and why, and reads nothing over http", async () => {
    const { call, calls } = fakeFetch((url) => {
      if (url.includes("missing")) return new Response("Not Found", { status: 404 })
      if (url.includes("huge")) return new Response("x", { headers: { "content-length": "60000000" } })
      if (url.includes("downgrade")) return new Response(null, { status: 301, headers: { location: "http://example.com/a.png" } })
      return new Response("<html>a page</html>")
    })
    const media = await read(
      [
        { source: "the body", url: "http://example.com/plain.png" },
        { source: "the body", url: "https://example.com/missing.png" },
        { source: "the body", url: "https://example.com/huge.mp4" },
        { source: "the body", url: "https://example.com/downgrade.png" },
        { source: "the body", url: "https://example.com/page.png" },
      ],
      { fetch: call },
    )
    expect(media.images).toEqual([])
    expect(media.lines).toEqual([
      "media 1: from the body, http://example.com/plain.png, could not be read: it is not served over https. Judge the change without it.",
      "media 2: from the body, https://example.com/missing.png, could not be read: it answered 404. Judge the change without it.",
      "media 3: from the body, https://example.com/huge.mp4, could not be read: it is larger than 50 MB. Judge the change without it.",
      "media 4: from the body, https://example.com/downgrade.png, could not be read: it is not served over https. Judge the change without it.",
      "media 5: from the body, https://example.com/page.png, could not be read: it is not an image or a video Tug reads (PNG, JPEG, GIF, WebP, MP4, MOV, WebM). Judge the change without it.",
    ])
    expect(calls.some((c) => c.url.startsWith("http:"))).toBe(false)
  })

  it("reads at most 10, and names the rest", async () => {
    const { call } = fakeFetch(() => new Response(PNG))
    const refs = Array.from({ length: 12 }, (_, i) => ({ source: "the body", url: `https://example.com/${i}.png` }))
    const media = await read(refs, { fetch: call })
    expect(media.images).toHaveLength(10)
    expect(media.lines.at(-1)).toBe("2 more media left out: the review reads at most 10.")
  })

  it("removes everything it wrote once the review is done, even when it fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tug-media-test-"))
    vi.stubEnv("RUNNER_TEMP", root)
    const { call } = fakeFetch(() => new Response(PNG))
    try {
      let during: string[] = []
      await withMedia({ repo: "o/r", head: "h", refs: [{ source: "the body", url: "https://example.com/a.png" }], options: { token: "t", fetch: call } }, async () => {
        during = readdirSync(root)
      })
      expect(during).toHaveLength(1)
      expect(readdirSync(root)).toEqual([])
      await expect(withMedia({ repo: "o/r", head: "h", refs: [], options: { token: "t", fetch: call } }, async () => { throw new Error("the model failed") })).rejects.toThrow("the model failed")
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses an ffmpeg download that doesn't match its checksum, and runs none", async () => {
    vi.stubEnv("PATH", "")
    const { call, calls } = fakeFetch((url) => (url.includes("ffmpeg-static") ? new Response("not ffmpeg") : new Response(Buffer.from("\0\0\0\x18ftypmp42 a video"))))
    const media = await read([{ source: "the body", url: "https://example.com/flow.mp4" }], { fetch: call })
    expect(media.images).toEqual([])
    expect(media.lines[0]).toContain("could not be read: ffmpeg's download does not match its checksum")
    expect(calls.some((c) => c.url.startsWith("https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-"))).toBe(process.platform === "linux")
  })
})

describe.skipIf(!FFMPEG)("with ffmpeg", () => {
  const make = (args: string[], name: string) => {
    const dir = mkdtempSync(join(tmpdir(), "tug-media-fixture-"))
    const path = join(dir, name)
    execFileSync(FFMPEG!, ["-hide_banner", "-loglevel", "error", ...args, "-y", path], { env: {} })
    const bytes = readFileSync(path)
    rmSync(dir, { recursive: true, force: true })
    return bytes
  }

  it("shows a video as 6 frames spread over it", async () => {
    const video = make(["-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=10", "-pix_fmt", "yuv420p"], "flow.mp4")
    const { call } = fakeFetch(() => new Response(video))
    const media = await read([{ source: "a comment by alice", url: "https://example.com/flow.mp4" }], { fetch: call, ffmpeg: FFMPEG })
    expect(media.images).toHaveLength(6)
    expect(media.images.every((image) => image.mediaType === "image/jpeg" && sniff(Buffer.from(image.data, "base64"))?.kind === "image")).toBe(true)
    expect(media.lines[0]).toMatch(/^media 1: video \(\d+ KB\) from a comment by alice, https:\/\/example\.com\/flow\.mp4, shown as 6 frames, at 0:00, 0:01, 0:02, 0:03, 0:04, 0:05$/u)
  })

  it("scales an image too large for a model down to a JPEG", async () => {
    const big = make(["-f", "lavfi", "-i", "nullsrc=s=2400x2400,geq=random(1)*255:128:128", "-frames:v", "1"], "noise.png")
    expect(big.length).toBeGreaterThan(3_500_000)
    const { call } = fakeFetch(() => new Response(big))
    const media = await read([{ source: "the body", url: "https://example.com/noise.png" }], { fetch: call, ffmpeg: FFMPEG })
    expect(media.images).toHaveLength(1)
    expect(media.images[0]!.mediaType).toBe("image/jpeg")
    expect(Buffer.from(media.images[0]!.data, "base64").length).toBeLessThanOrEqual(3_500_000)
  })

  it("stops at 16 images, giving a late video only the frames left", async () => {
    const video = make(["-f", "lavfi", "-i", "testsrc=duration=6:size=160x120:rate=10", "-pix_fmt", "yuv420p"], "flow.mp4")
    const { call } = fakeFetch((url) => new Response(url.endsWith(".mp4") ? video : PNG))
    const refs = [...Array.from({ length: 8 }, (_, i) => ({ source: "the body", url: `https://example.com/${i}.png` })), { source: "the body", url: "https://example.com/a.mp4" }, { source: "the body", url: "https://example.com/b.mp4" }]
    const media = await read(refs, { fetch: call, ffmpeg: FFMPEG })
    expect(media.images).toHaveLength(16)
    expect(media.lines[8]).toContain("shown as 6 frames")
    expect(media.lines[9]).toContain("shown as 2 frames")
  })
})

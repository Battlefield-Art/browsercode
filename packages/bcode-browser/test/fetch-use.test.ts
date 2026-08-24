// FetchUse smoke tests.
//
// Unit: layer is constructible, `enabled` reflects BROWSER_USE_API_KEY presence.
// Live: when the key is set, end-to-end POST to fetch.browser-use.com returns
//       body bytes + content-type. Skipped without the key. Config-based
//       opt-in (experimental.fetch_use=true) is enforced in webfetch.ts,
//       not here.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { FetchUse } from "../src/fetch-use"

const haveKey = !!process.env.BROWSER_USE_API_KEY

test("layer constructs and exposes `enabled` reflecting env", async () => {
  const enabled = await Effect.gen(function* () {
    return (yield* FetchUse.Service).enabled
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)
  expect(enabled).toBe(haveKey)
})

test("BCODE_FETCH_USE_ENDPOINT redirects the request and forwards the target url", async () => {
  // A real server, so this pins the wire behaviour a mediating proxy depends on:
  // the override must be used AND the target url must arrive in the body, or the
  // proxy has nothing to forward.
  const seen: { url?: string; key?: string } = {}
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.url = ((await req.json()) as { url: string }).url
      seen.key = req.headers.get("X-Browser-Use-API-Key") ?? undefined
      return Response.json({ status_code: 200, body: "ok", headers: { "content-type": ["text/plain"] } })
    },
  })
  const realKey = process.env.BROWSER_USE_API_KEY
  process.env.BCODE_FETCH_USE_ENDPOINT = `http://localhost:${server.port}/fetch`
  process.env.BROWSER_USE_API_KEY = "sentinel-not-a-real-key"
  try {
    const result = await Effect.gen(function* () {
      return yield* (yield* FetchUse.Service).fetch("https://example.com/page", { timeoutMs: 30_000 })
    }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)

    expect(seen.url).toBe("https://example.com/page")
    expect(seen.key).toBe("sentinel-not-a-real-key")
    expect(new TextDecoder().decode(result.body)).toBe("ok")
  } finally {
    server.stop(true)
    delete process.env.BCODE_FETCH_USE_ENDPOINT
    if (realKey === undefined) delete process.env.BROWSER_USE_API_KEY
    else process.env.BROWSER_USE_API_KEY = realKey
  }
})

// The endpoint carries the api key, so a bad value leaks a credential rather
// than merely failing. Loopback http is allowed because a mediating proxy on the
// same host is the normal local arrangement.
test.each([
  ["", "set but empty"],
  ["   ", "set but empty"],
  ["not-a-url", "not a valid url"],
  ["http://evil.example/fetch", "https outside loopback"],
  // Would otherwise pass startup and fail at the first webfetch instead.
  ["ftp://localhost/fetch", "must be http or https"],
])("rejects BCODE_FETCH_USE_ENDPOINT=%p", (value, reason) => {
  process.env.BCODE_FETCH_USE_ENDPOINT = value
  try {
    expect(() =>
      Effect.runSync(
        Effect.gen(function* () {
          return (yield* FetchUse.Service).enabled
        }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
      ),
    ).toThrow(new RegExp(reason.replace(/ /g, "\\s")))
  } finally {
    delete process.env.BCODE_FETCH_USE_ENDPOINT
  }
})

test("rejection does not echo credentials carried in the endpoint value", () => {
  // An endpoint can embed userinfo or a token in its query. Writing that into
  // stderr on a typo is the same log leak this override exists to close, so the
  // message may name the origin and nothing more.
  process.env.BCODE_FETCH_USE_ENDPOINT = "http://user:hunter2@evil.example:8080/f?token=SECRET"
  try {
    let message = ""
    try {
      Effect.runSync(
        Effect.gen(function* () {
          return (yield* FetchUse.Service).enabled
        }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
      )
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain("https outside loopback")
    expect(message).toContain("evil.example:8080")
    expect(message).not.toContain("hunter2")
    expect(message).not.toContain("SECRET")
  } finally {
    delete process.env.BCODE_FETCH_USE_ENDPOINT
  }
})

test.each([
  "https://proxy.example/fetch",
  "http://127.0.0.1:7461/fetch",
  "http://[::1]:7461/fetch",
  // The whole 127/8 is loopback, and a rooted name is the same name.
  "http://127.0.0.2:9/fetch",
  "http://localhost./fetch",
])("accepts BCODE_FETCH_USE_ENDPOINT=%p", (value) => {
    process.env.BCODE_FETCH_USE_ENDPOINT = value
    try {
      expect(() =>
        Effect.runSync(
          Effect.gen(function* () {
            return (yield* FetchUse.Service).enabled
          }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
        ),
      ).not.toThrow()
    } finally {
      delete process.env.BCODE_FETCH_USE_ENDPOINT
    }
  },
)

test.skipIf(!haveKey)("live: fetches httpbin and returns body + content-type", async () => {
  const result = await Effect.gen(function* () {
    return yield* (yield* FetchUse.Service).fetch("https://httpbin.org/get", { timeoutMs: 30_000 })
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)

  expect(result.contentType).toContain("application/json")
  expect(JSON.parse(new TextDecoder().decode(result.body)).url).toBe("https://httpbin.org/get")
})

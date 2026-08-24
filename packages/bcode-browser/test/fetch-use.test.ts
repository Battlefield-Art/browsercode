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

test.skipIf(!haveKey)("live: fetches httpbin and returns body + content-type", async () => {
  const result = await Effect.gen(function* () {
    return yield* (yield* FetchUse.Service).fetch("https://httpbin.org/get", { timeoutMs: 30_000 })
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)

  expect(result.contentType).toContain("application/json")
  expect(JSON.parse(new TextDecoder().decode(result.body)).url).toBe("https://httpbin.org/get")
})

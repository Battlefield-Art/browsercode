// FetchUse — Effect service that proxies HTTP through Browser Use's fetch-use
// cloud (Chrome JA4, HTTP/2 header order, session cookies). Decisions §3.3.
// `enabled` is true when BROWSER_USE_API_KEY is set; webfetch.ts combines
// this with the user's `experimental.fetch_use` opencode.json setting.

import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

const DEFAULT_ENDPOINT = "https://fetch.browser-use.com/fetch"

export interface FetchResult {
  readonly body: ArrayBuffer
  readonly contentType: string
}

interface FetchUseRaw {
  status_code: number
  headers?: Record<string, string[]>
  body?: string
  body_base64?: string
  is_binary?: boolean
  error?: string
}

export class Service extends Context.Service<Service, {
  readonly enabled: boolean
  readonly fetch: (url: string, opts: { timeoutMs: number }) => Effect.Effect<FetchResult, Error>
}>()("@browser-use/FetchUse") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const apiKey = process.env.BROWSER_USE_API_KEY ?? ""
    const endpoint = resolveEndpoint()
    return Service.of({
      enabled: apiKey.length > 0,
      fetch: (url, { timeoutMs }) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeaders({ "Content-Type": "application/json", "X-Browser-Use-API-Key": apiKey }),
            HttpClientRequest.bodyJson({ url, timeout_ms: timeoutMs }),
          )
          const response = yield* HttpClient.filterStatusOk(http).execute(request)
          const data = (yield* response.json) as unknown as FetchUseRaw
          if (data.error) return yield* Effect.fail(new Error(`fetch-use: ${data.error}`))
          // Mirror native path's filterStatusOk: surface upstream HTTP errors as failures.
          if (data.status_code >= 400) return yield* Effect.fail(new Error(`fetch-use: HTTP ${data.status_code}`))
          const body = data.is_binary && data.body_base64
            ? (new Uint8Array(Buffer.from(data.body_base64, "base64")).buffer as ArrayBuffer)
            : (new TextEncoder().encode(data.body ?? "").buffer as ArrayBuffer)
          const ct =
            Object.entries(data.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.[0] ?? ""
          return { body, contentType: ct }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e))))),
    })
  }),
)

// Overridable so a caller can mediate the request and keep the real key out of
// this process entirely. The default endpoint is a general-purpose URL fetcher,
// so anything holding the key can send it to an arbitrary host -- an untrusted
// or injectable agent should be given a mediating endpoint and a throwaway
// credential instead of the real one.
//
// Every rejection below is an operator mistake at startup, and each one would
// otherwise put X-Browser-Use-API-Key somewhere it should not go. Set-but-empty
// is a mistake rather than a default, because the default is the direct fetcher
// -- the exact path someone setting this variable is trying to leave.
function resolveEndpoint() {
  const configured = process.env.BCODE_FETCH_USE_ENDPOINT
  if (configured === undefined) return DEFAULT_ENDPOINT
  if (configured.trim() === "")
    throw new Error("BCODE_FETCH_USE_ENDPOINT is set but empty; unset it to use the default fetcher")
  if (!URL.canParse(configured)) throw new Error(`BCODE_FETCH_USE_ENDPOINT is not a valid url: ${configured}`)
  const url = new URL(configured)
  // Node reports the IPv6 literal with its brackets, so "::1" would never match.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !loopback)
    throw new Error(
      `BCODE_FETCH_USE_ENDPOINT must use https outside loopback; refusing to send the api key in cleartext to ${configured}`,
    )
  return configured
}

export * as FetchUse from "./fetch-use"

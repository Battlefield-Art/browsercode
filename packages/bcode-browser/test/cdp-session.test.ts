// waitFor semantics against a bare WebSocket server (no Chrome needed).
// Test structure adapted from PR #111 by @MagMueller.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Session } from "../src/cdp/session"

const channel = "cdp-events"
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("nope", { status: 400 })
  },
  websocket: {
    open(ws) {
      ws.subscribe(channel)
    },
    message() {},
  },
})
const session = new Session()
const emit = (method: string, params: unknown) => {
  server.publish(channel, JSON.stringify({ method, params }))
}

beforeAll(async () => {
  await session.connect({ wsUrl: `ws://127.0.0.1:${server.port}/` })
})

afterAll(() => {
  session.close()
  server.stop(true)
})

test("waitFor resolves on a matching event, respecting the predicate", async () => {
  const waiting = session.waitFor<{ ready: boolean }>("Test.event", {
    predicate: (params) => params.ready,
    timeoutMs: 1_000,
  })
  emit("Test.event", { ready: false })
  emit("Test.event", { ready: true })
  expect(await waiting).toEqual({ ready: true })
})

test("waitFor honors timeoutMs", async () => {
  await expect(session.waitFor("Test.timeout", { timeoutMs: 20 })).rejects.toThrow("Timeout waiting for Test.timeout")
})

test("waitFor rejects and unsubscribes when a predicate throws", async () => {
  let calls = 0
  const waiting = session.waitFor("Test.bad", {
    predicate: () => {
      calls++
      throw new Error("predicate failed")
    },
    timeoutMs: 1_000,
  })
  emit("Test.bad", {})
  await expect(waiting).rejects.toThrow("predicate failed")
  emit("Test.bad", {})
  await Bun.sleep(10)
  expect(calls).toBe(1)
})

test("waitFor throws synchronously on the removed positional-predicate form", () => {
  // @ts-expect-error old signature: waitFor(method, predicate, timeoutMs)
  expect(() => session.waitFor("Test.positional", () => true, 1_000)).toThrow(TypeError)
})

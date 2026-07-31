import { afterAll, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Effect } from "effect";
import { BrowserExecute } from "../src/browser-execute";
import { SessionStore } from "../src/session-store";

let connections = 0;
let attachedCalls = 0;
let pageCallsWithSession = 0;
let latestSocket: { close(): void } | undefined;
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req)
      ? undefined
      : new Response("upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      connections++;
      latestSocket = ws;
    },
    message(ws, message) {
      const request: unknown = JSON.parse(String(message));
      if (
        !request ||
        typeof request !== "object" ||
        !("id" in request) ||
        typeof request.id !== "number" ||
        !("method" in request) ||
        typeof request.method !== "string"
      )
        return;
      const result = (() => {
        if (request.method === "Target.getTargets")
          return {
            targetInfos: [
              {
                targetId: "page-1",
                type: "page",
                title: "",
                url: "about:blank",
                attached: false,
                canAccessOpener: false,
              },
            ],
          };
        if (request.method === "Target.attachToTarget") {
          attachedCalls++;
          return { sessionId: "page-session-1" };
        }
        if (request.method.startsWith("Page.") && "sessionId" in request)
          pageCallsWithSession++;
        return {};
      })();
      ws.send(JSON.stringify({ id: request.id, result }));
    },
    close() {},
  },
});

const failingServer = Bun.serve({
  port: 0,
  fetch() {
    return new Response("unavailable", { status: 503 });
  },
});

afterAll(() => {
  server.stop(true);
  failingServer.stop(true);
});

const wsUrl = `ws://127.0.0.1:${server.port}/`;

const withEnv = async <T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return await fn();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

const withBrowserExecute = async (
  name: string,
  fn: (
    impl: Effect.Success<ReturnType<typeof BrowserExecute.make>>,
    sessionID: string,
    workspaceDir: string,
  ) => Promise<void>,
) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `bcode-auto-data-${name}-`),
  );
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `bcode-auto-ws-${name}-`),
  );
  const sessionID = `auto-connect-${name}-${Math.random().toString(36).slice(2)}`;
  try {
    const impl = await Effect.runPromise(
      Effect.scoped(BrowserExecute.make(dataDir)),
    );
    await fn(impl, sessionID, workspaceDir);
  } finally {
    await SessionStore.evict(sessionID);
    await Promise.all(
      [dataDir, workspaceDir].map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  }
};

test("cloud endpoint auto-connects, attaches, and reuses one connection", async () => {
  connections = 0;
  attachedCalls = 0;
  pageCallsWithSession = 0;
  await withEnv({ BU_CDP_WS: wsUrl, BU_CDP_URL: undefined }, () =>
    withBrowserExecute("reuse", async (impl, sessionID, workspaceDir) => {
      const run = (code: string) =>
        Effect.runPromise(
          impl.execute(
            { description: "List browser targets", code },
            { sessionID, workspaceDir },
          ),
        );

      expect(
        JSON.parse(
          (
            await run(
              "return await session.Page.navigate({ url: 'https://sap.com' })",
            )
          ).result,
        ),
      ).toEqual({});
      expect(
        JSON.parse(
          (
            await run(
              "await session.connect(); return (await session.Target.getTargets({})).targetInfos.length",
            )
          ).result,
        ),
      ).toBe(1);
      expect(connections).toBe(1);
      expect(attachedCalls).toBe(1);
      expect(pageCallsWithSession).toBe(1);
    }),
  );
});

test("parallel first calls share one connection attempt", async () => {
  connections = 0;
  attachedCalls = 0;
  await withEnv({ BU_CDP_WS: wsUrl, BU_CDP_URL: undefined }, () =>
    withBrowserExecute("race", async (impl, sessionID, workspaceDir) => {
      const run = () =>
        Effect.runPromise(
          impl.execute(
            {
              description: "Read target count",
              code: "return (await session.Target.getTargets({})).targetInfos.length",
            },
            { sessionID, workspaceDir },
          ),
        );

      expect(
        (await Promise.all([run(), run()])).map((result) =>
          JSON.parse(result.result),
        ),
      ).toEqual([1, 1]);
      expect(connections).toBe(1);
      expect(attachedCalls).toBe(1);
    }),
  );
});

test("a dropped provisioned socket reconnects and reattaches", async () => {
  connections = 0;
  attachedCalls = 0;
  await withEnv({ BU_CDP_WS: wsUrl, BU_CDP_URL: undefined }, () =>
    withBrowserExecute("dropped", async (impl, sessionID, workspaceDir) => {
      const run = () =>
        Effect.runPromise(
          impl.execute(
            {
              description: "Navigate existing page",
              code: "return await session.Page.navigate({ url: 'https://sap.com' })",
            },
            { sessionID, workspaceDir },
          ),
        );

      await run();
      latestSocket?.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await run();

      expect(connections).toBe(2);
      expect(attachedCalls).toBe(2);
    }),
  );
});

test("sessions without a provisioned endpoint still require connect", async () => {
  await withEnv({ BU_CDP_WS: undefined, BU_CDP_URL: undefined }, () =>
    withBrowserExecute("local", async (impl, sessionID, workspaceDir) => {
      await expect(
        Effect.runPromise(
          impl.execute(
            {
              description: "Call CDP without connect",
              code: "return await session.Target.getTargets({})",
            },
            { sessionID, workspaceDir },
          ),
        ),
      ).rejects.toThrow("Not connected. Call session.connect(...) first.");
    }),
  );
});

test("failed auto-connect reports the connection error before running the snippet", async () => {
  await withEnv(
    {
      BU_CDP_WS: `ws://127.0.0.1:${failingServer.port}/`,
      BU_CDP_URL: undefined,
    },
    () =>
      withBrowserExecute("failure", async (impl, sessionID, workspaceDir) => {
        const failure = Effect.runPromise(
          impl.execute(
            {
              description: "Do not run snippet",
              code: 'throw new Error("snippet should not run")',
            },
            { sessionID, workspaceDir },
          ),
        );

        await expect(failure).rejects.toThrow(/WS error|WS closed before open/);
        await expect(failure).rejects.not.toThrow(
          "browser_execute snippet threw",
        );
        await expect(failure).rejects.not.toThrow("snippet should not run");
      }),
  );
});

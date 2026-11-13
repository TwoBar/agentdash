import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiFailure, LocalApi } from "./api.js";

function harness(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetcher = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const response = responses.shift();
    assert.ok(response, "Unexpected request");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { api: new LocalApi(fetcher), calls };
}

test("GET authentication recovery establishes cookie and refreshes safely without a mutation", async () => {
  const { api, calls } = harness([
    { status: 401, body: {} },
    { status: 200, body: "synthetic page" },
    { status: 200, body: { csrfToken: "synthetic-token" } },
    { status: 200, body: { projects: [] } },
  ]);
  assert.deepEqual(await api.get("/state"), { projects: [] });
  assert.deepEqual(
    calls.map((c) => [c.path, c.init.method]),
    [
      ["/api/state", "GET"],
      ["/", "GET"],
      ["/api/session", "GET"],
      ["/api/state", "GET"],
    ],
  );
});

test("expired mutation authentication renews but never replays the submitted action", async () => {
  const { api, calls } = harness([
    { status: 200, body: { csrfToken: "synthetic-old" } },
    {
      status: 401,
      body: { error: { code: "unauthenticated", message: "Expired" } },
    },
    { status: 200, body: "synthetic page" },
    { status: 200, body: { csrfToken: "synthetic-new" } },
  ]);
  await assert.rejects(
    api.post("/projects/a/approvals/resolve", { members: ["synthetic"] }),
    (error) => error instanceof ApiFailure && error.code === "session_renewed",
  );
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});

test("specific server fields and retryability survive the client error boundary", async () => {
  const { api } = harness([
    { status: 200, body: { csrfToken: "synthetic-token" } },
    {
      status: 400,
      body: {
        error: {
          code: "workspace_missing",
          message: "Choose an existing local directory.",
          retryable: false,
          fieldErrors: { workspace: "Directory does not exist" },
        },
      },
    },
  ]);
  await assert.rejects(
    api.post("/projects", {}),
    (error) =>
      error instanceof ApiFailure &&
      error.code === "workspace_missing" &&
      error.operation === "Create project" &&
      error.fieldErrors.workspace === "Directory does not exist" &&
      !error.retryable,
  );
});

test("uncertain network failure is reported without replay or leaking request data", async () => {
  let posts = 0;
  const api = new LocalApi((async (path: string, init: RequestInit) => {
    if (path === "/api/session")
      return new Response(JSON.stringify({ csrfToken: "synthetic" }));
    posts++;
    throw new Error("synthetic transport internals");
  }) as typeof fetch);
  await assert.rejects(
    api.post("/projects", { name: "synthetic" }),
    (error) =>
      error instanceof ApiFailure &&
      error.code === "connection_unavailable" &&
      !error.message.includes("synthetic transport internals"),
  );
  assert.equal(posts, 1);
});

test("parallel expired reads share one cookie/CSRF renewal", async () => {
  let stateReads = 0,
    bootstrap = 0,
    sessions = 0;
  const api = new LocalApi((async (path: string) => {
    if (path === "/") {
      bootstrap++;
      return new Response("synthetic page");
    }
    if (path === "/api/session") {
      sessions++;
      return new Response(JSON.stringify({ csrfToken: "synthetic-new" }));
    }
    stateReads++;
    return new Response(
      JSON.stringify(stateReads <= 2 ? {} : { ready: true }),
      { status: stateReads <= 2 ? 401 : 200 },
    );
  }) as typeof fetch);
  const results = await Promise.all([api.get("/state"), api.get("/state")]);
  assert.deepEqual(results, [{ ready: true }, { ready: true }]);
  assert.equal(bootstrap, 1);
  assert.equal(sessions, 1);
  assert.equal(stateReads, 4);
});

test("an Origin rejection is never treated as an expired session or retried", async () => {
  const { api, calls } = harness([
    { status: 200, body: { csrfToken: "synthetic" } },
    {
      status: 403,
      body: { error: { code: "origin_rejected", message: "Untrusted origin" } },
    },
  ]);
  await assert.rejects(
    api.post("/projects", {}),
    (error) => error instanceof ApiFailure && error.code === "origin_rejected",
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/session", "/api/projects"],
  );
});

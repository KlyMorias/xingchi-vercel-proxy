const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createGateway, GATEWAY_BODY_LIMITS } = require("../server.cjs");

const KEY = "kly_" + "s".repeat(43);
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
test.beforeEach(() => {
  process.env.XINGCHI_SOL_API_KEY = "standalone-test-provider-key";
  delete process.env.MAX_OUTPUT_TOKENS;
  delete process.env.DEFAULT_OUTPUT_TOKENS;
  process.env.UPSTREAM_AUTH_MODE = "authorization";
});
test.afterEach(() => { process.env = { ...originalEnv }; global.fetch = originalFetch; });

function terminal() {
  return { id: "resp_gateway", object: "response", status: "completed", model: "gpt-6.1-sol",
    output: [{ id: "msg_gateway", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }] }],
    usage: { input_tokens: 17, output_tokens: 11, total_tokens: 28 } };
}

function store(overrides = {}) {
  return { isConfigured: () => true, authenticate: async () => ({ ok: true }),
    reserve: async () => ({ ok: true, reservation: { id: "gateway-test" } }),
    settle: async () => {}, release: async () => {}, ...overrides };
}

async function listen(t, options = {}) {
  const server = createGateway({ store: store(), ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port: server.address().port };
}

function request(port, { path = "/api/v1/responses", method = "POST", headers = {}, body,
  chunks, onData } = {}) {
  const data = body === undefined ? Buffer.from('{"model":"gpt-6.1-sol","input":"hello","max_output_tokens":32}') : Buffer.from(body);
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const requestHeaders = { authorization: `Bearer ${KEY}`, "content-type": "application/json",
      ...(chunks ? { "transfer-encoding": "chunked" } : { "content-length": String(data.length) }), ...headers };
    for (const [name, value] of Object.entries(requestHeaders)) if (value === undefined) delete requestHeaders[name];
    const req = http.request({ hostname: "127.0.0.1", port, method, path, agent: false,
      headers: requestHeaders },
    (res) => {
      responseStarted = true;
      const buffers = [];
      res.on("data", (chunk) => { buffers.push(chunk); onData?.(chunk.toString("utf8"), res); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buffers).toString("utf8") }));
      res.on("error", (error) => { error.httpStage = "response"; reject(error); });
    });
    req.setTimeout(25_000, () => req.destroy(new Error("HTTP test request timed out")));
    req.on("error", (error) => { if (!responseStarted) { error.httpStage = "request"; reject(error); } });
    (async () => {
      const parts = chunks || [data];
      for (const chunk of parts) {
        if (responseStarted || req.destroyed) break;
        if (!req.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              req.off("drain", done); req.off("close", done); req.off("response", done);
              resolve();
            };
            req.once("drain", done); req.once("close", done); req.once("response", done);
          });
        }
      }
      if (!req.destroyed && !req.writableEnded) req.end();
    })().catch(reject);
  });
}

function imageBody(size) {
  const prefix = Buffer.from('{"model":"gpt-6.1-sol","input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,');
  let suffix = Buffer.from('"}]}],"max_output_tokens":32}');
  let length = size - prefix.length - suffix.length;
  suffix = Buffer.concat([suffix, Buffer.alloc(length % 4, 32)]);
  length -= length % 4;
  function* chunks() {
    yield prefix;
    const block = Buffer.alloc(64 * 1024, 65);
    let remaining = length;
    while (remaining) {
      const bytes = Math.min(block.length, remaining);
      yield block.subarray(0, bytes);
      remaining -= bytes;
    }
    yield suffix;
  }
  return { length, chunks };
}

for (const chunked of [false, true]) {
  test(`a real HTTP ${chunked ? "chunked" : "Content-Length"} upload forwards exactly 50 MiB of valid image JSON`, async (t) => {
    let authenticated = 0;
    let reserved = 0;
    let settled = 0;
    const size = 50 * 1024 * 1024;
    const fixture = imageBody(size);
    let wireBytes = 0;
    function* upload() { for (const chunk of fixture.chunks()) { wireBytes += chunk.length; yield chunk; } }
    const { port } = await listen(t, { store: store({
      authenticate: async (token) => { assert.equal(token, KEY); authenticated++; return { ok: true }; },
      reserve: async (token, options) => {
        assert.equal(token, KEY);
        assert.equal(options.consumeDaily, true);
        assert.equal(options.ip, "127.0.0.1", "forwarded IP headers must not be trusted");
        assert.ok(options.estimatedTokens >= size);
        reserved++;
        return { ok: true, reservation: { id: "large" } };
      },
      settle: async (_ticket, usage) => { settled++; assert.equal(usage.total_tokens, 28); },
    }) });
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.xingchiapi.com/v1/responses");
      const payload = JSON.parse(options.body);
      assert.equal(payload.input[0].content[0].image_url.length, "data:image/png;base64,".length + fixture.length);
      assert.equal(payload.stream, true);
      assert.equal(payload.store, false);
      assert.equal(options.headers.get("authorization"), "Bearer standalone-test-provider-key");
      return new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
    };
    const response = await request(port, { chunks: upload(), headers: {
      ...(chunked ? {} : { "content-length": String(size), "transfer-encoding": undefined }),
      "x-vercel-forwarded-for": "203.0.113.25", "x-forwarded-for": "203.0.113.26", "x-real-ip": "203.0.113.27",
    } });
    assert.equal(wireBytes, size);
    assert.equal(response.status, 200, response.body);
    assert.equal(JSON.parse(response.body).status, "completed");
    assert.deepEqual([authenticated, reserved, settled], [1, 1, 1]);
  });
}

test("oversized Content-Length and actual chunked bytes return readable 413 JSON before quota", async (t) => {
  let reservations = 0;
  const { port } = await listen(t, { store: store({ reserve: async () => { reservations++; assert.fail("oversized bodies must not reserve quota"); } }) });
  global.fetch = async () => assert.fail("oversized bodies must not reach the provider");
  const declared = await request(port, { body: "{}", headers: { "content-length": String(GATEWAY_BODY_LIMITS.maxWireBytes + 1) } });
  assert.equal(declared.status, 413);
  assert.ok(JSON.parse(declared.body).error.includes(`${GATEWAY_BODY_LIMITS.maxWireBytes}-byte`));
  assert.equal(declared.headers.connection, "close");
  function* oversized() {
    const chunk = Buffer.alloc(64 * 1024, 32);
    for (let bytes = 0; bytes <= GATEWAY_BODY_LIMITS.maxWireBytes; bytes += chunk.length) yield chunk;
  }
  const streamed = await request(port, { chunks: oversized() });
  assert.equal(streamed.status, 413, streamed.body);
  assert.ok(JSON.parse(streamed.body).error.includes(`${GATEWAY_BODY_LIMITS.maxWireBytes}-byte`));
  assert.equal(streamed.headers.connection, "close");
  assert.equal(reservations, 0);
});

test("only exact public API aliases and the health endpoint are exposed", async (t) => {
  let reservations = 0;
  const { port } = await listen(t, { store: store({ reserve: async (_key, options) => {
    assert.equal(options.consumeDaily, false); reservations++; return { ok: true };
  } }) });
  global.fetch = async () => assert.fail("model lists and blocked paths must not call the provider");
  const health = await request(port, { path: "/healthz", method: "GET", body: "" });
  assert.deepEqual(JSON.parse(health.body), { ok: true });
  for (const path of ["/", "/key", "/login", "/api/account", "/api/keys", "/api/users", "/.env", "/server.cjs",
    "/lib/state-store.js", "/api/proxy?path=v1/models", "/api/v1/responses/", "/v1/../v1/models", "/%76%31/models"]) {
    const result = await request(port, { path, method: "GET", body: "" });
    assert.equal(result.status, 404, path);
    assert.doesNotMatch(result.body, /standalone-test-provider-key/);
  }
  for (const path of ["/v1/models", "/api/models", "/api/v1/models?path=admin/keys"]) {
    const result = await request(port, { path, method: "GET", body: "" });
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).object, "list");
  }
  assert.equal(reservations, 3);
  const wrongMethod = await request(port, { path: "/v1/responses", method: "GET", body: "" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST, OPTIONS");
  const preflight = await request(port, { method: "OPTIONS", body: "", headers: { authorization: "" } });
  assert.equal(preflight.status, 204);
});

test("invalid and revoked keys fail before body processing or quota, and auth storage failure returns safe 503", async (t) => {
  let checked = 0;
  let unavailable = false;
  const { port } = await listen(t, { store: store({ authenticate: async () => {
    checked++;
    if (unavailable) throw new Error("private storage detail");
    return { ok: false, status: 401 };
  }, reserve: async () => assert.fail("failed authentication must not reserve quota") }) });
  global.fetch = async () => assert.fail("failed authentication must not call the provider");
  assert.equal((await request(port, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal(checked, 0);
  assert.equal((await request(port)).status, 401);
  assert.equal(checked, 1);
  unavailable = true;
  const result = await request(port);
  assert.equal(result.status, 503);
  assert.equal(result.headers["retry-after"], "2");
  assert.doesNotMatch(result.body, /private storage detail/);
});

test("all generation aliases share the proxy and accept its supported credential headers", async (t) => {
  const { port } = await listen(t);
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  };
  for (const prefix of ["/v1", "/api", "/api/v1"]) {
    for (const suffix of ["responses", "chat/completions", "messages"]) {
      const body = { model: "gpt-6.1-sol", ...(suffix === "responses" ? { input: "hello" }
        : { messages: [{ role: "user", content: "hello" }], max_tokens: 32 }) };
      const headers = suffix === "responses" ? {} : suffix === "messages"
        ? { authorization: "", "x-api-key": KEY } : { authorization: "", "x-proxy-key": KEY };
      const result = await request(port, { path: `${prefix}/${suffix}`, body: JSON.stringify(body), headers });
      assert.equal(result.status, 200, result.body);
    }
  }
  assert.equal(calls, 9);
});

test("closing a client during authentication does not free admission before storage finishes", async (t) => {
  let begin;
  let finish;
  let checks = 0;
  const begun = new Promise((resolve) => { begin = resolve; });
  const finished = new Promise((resolve) => { finish = resolve; });
  const { port } = await listen(t, { store: store({ authenticate: async () => {
    if (++checks === 1) { begin(); await finished; }
    return { ok: true };
  } }) });
  global.fetch = async () => assert.fail("disconnected authentication must not reach the provider");
  const client = http.request({ hostname: "127.0.0.1", port, path: "/v1/responses", method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } });
  client.on("error", () => {});
  client.end('{"input":"hello"}');
  await begun;
  const closed = new Promise((resolve) => client.once("close", resolve));
  client.destroy();
  await closed;
  assert.equal((await request(port)).status, 503);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  global.fetch = async () => new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  assert.equal((await request(port)).status, 200);
});

test("POST admission stays occupied through processing and is released for the next request", async (t) => {
  const { port } = await listen(t);
  let begin;
  const begun = new Promise((resolve) => { begin = resolve; });
  let finish;
  global.fetch = async () => {
    begin();
    await new Promise((resolve) => { finish = resolve; });
    return new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  };
  const first = request(port);
  await begun;
  const busy = await request(port);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers["retry-after"], "2");
  finish();
  assert.equal((await first).status, 200);
  global.fetch = async () => new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  assert.equal((await request(port)).status, 200);
});

test("streamed events reach the real HTTP client before completion and settle before terminal output", async (t) => {
  let settled = false;
  let complete;
  const { port } = await listen(t, { store: store({ settle: async () => { settled = true; } }) });
  global.fetch = async () => new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { ...terminal(), status: "in_progress", output: [] } })}\n\n`));
    complete = () => { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: terminal() })}\n\n`)); controller.close(); };
  } }), { headers: { "content-type": "text/event-stream" } });
  let firstSeen = false;
  const response = await request(port, { body: JSON.stringify({ input: "hello", stream: true }), onData(frame) {
    if (!firstSeen && frame.includes("response.created")) {
      firstSeen = true;
      assert.equal(settled, false);
      assert.doesNotMatch(frame, /response.completed/);
      complete();
    }
    if (frame.includes("response.completed")) assert.equal(settled, true);
  } });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.equal(firstSeen, true);
  assert.match(response.body, /response.completed/);
});

test("a disconnected HTTP stream aborts provider work and releases its token reservation", async (t) => {
  let aborted;
  let refunded;
  const sawAbort = new Promise((resolve) => { aborted = resolve; });
  const sawRefund = new Promise((resolve) => { refunded = resolve; });
  const { port } = await listen(t, { keepaliveIntervalMs: 10, store: store({ release: async () => refunded() }) });
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => { aborted(); reject(new DOMException("Canceled", "AbortError")); }, { once: true });
  });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/responses", method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } }, (res) => {
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", reject);
    req.end('{"input":"hello","stream":true}');
  });
  await Promise.race([Promise.all([sawAbort, sawRefund]), new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider cancellation timed out")), 2000); timer.unref();
  })]);
});

test("the HTTP server has finite upload and header deadlines", async (t) => {
  const { server, port } = await listen(t, { uploadTimeoutMs: 100, headersTimeoutMs: 100 });
  assert.equal(server.requestTimeout, 100);
  assert.equal(server.headersTimeout, 100);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/responses", method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "content-length": "1000" } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.write("{");
  });
  assert.equal(status, 408);
});

test("standalone startup requires its memory flags and rejects invalid admission settings", () => {
  for (const value of [0, -1, 17, 1.5, Infinity]) assert.throws(() => createGateway({ maxConcurrentRequests: value }), TypeError);
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "server.cjs")], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /npm start/);
});

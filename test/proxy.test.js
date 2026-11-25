const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { gzipSync, zstdCompressSync } = require("node:zlib");
const { MAX_DECODED_BYTES } = require("../lib/request-body");

const proxyModule = require("../api/proxy.js");
const handler = proxyModule.createHandler({ isConfigured: () => true,
  reserve: async () => ({ ok: true, reservation: null }), release: async () => {} });
handler.createHandler = proxyModule.createHandler;

function makeRequest({ method = "POST", path = ["v1", "responses"], headers = {}, body = '{"input":"hello"}' } = {}) {
  return {
    method,
    query: { path },
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function makeResponse() {
  const events = new EventEmitter();
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: "",
    writtenChunks: chunks,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    write(chunk) {
      this.headersSent = true;
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.headersSent = true;
      this.ended = true;
      this.writableEnded = true;
    },
    on: events.on.bind(events),
    off: events.off.bind(events),
    once: events.once.bind(events),
  };
}

function responseFixture(text = "OK") {
  return {
    id: "resp_test", object: "response", status: "completed", created_at: 1795160000,
    model: "gpt-6.1-sol",
    output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

function successfulResponse(text = "OK") {
  return new Response(JSON.stringify(responseFixture(text)), {
    headers: { "content-type": "application/json" },
  });
}

function eventFrame(event) {
  return Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
test.beforeEach(() => {
  delete process.env.MAX_OUTPUT_TOKENS;
  delete process.env.DEFAULT_OUTPUT_TOKENS;
  delete process.env.XINGCHI_SOL_API_KEY;
  delete process.env.XINGCHI_ASTRA_API_KEY;
});
test.afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("rejects unauthorized callers without contacting Xingchi", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };

  const res = makeResponse();
  await handler(makeRequest({ headers: { "content-type": "application/json" } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test("uses server-side credentials and the Responses upstream for a normal JSON client", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  process.env.UPSTREAM_AUTH_MODE = "x-api-key";
  let observed;
  global.fetch = async (url, options) => {
    observed = { url, options };
    return successfulResponse();
  };

  const res = makeResponse();
  await handler(makeRequest({
    headers: {
      authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "client-token",
    },
    body: '{"model":"gpt-6.1-sol","input":"hello"}',
  }), res);

  assert.equal(observed.url, "https://api.xingchiapi.com/v1/responses");
  assert.equal(observed.options.headers.get("x-api-key"), "upstream-secret");
  assert.equal(observed.options.headers.get("authorization"), null);
  assert.equal(observed.options.headers.get("anthropic-version"), "2023-06-01");
  assert.match(observed.options.headers.get("user-agent"), /KlyAPI.*compatibility gateway/);
  assert.equal(observed.options.headers.get("originator"), "codex_cli_rs");
  const request = JSON.parse(observed.options.body);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 2048);
  assert.equal(request.input[0].role, "user");
  assert.equal(request.input[0].content[0].text, "hello");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), responseFixture());
  assert.equal(res.body.includes("upstream-secret"), false);
  assert.match(res.headers["server-timing"], /(?:^|,\s*)quota;dur=\d+(?:\.\d+)?(?:,|$)/);
  assert.match(res.headers["server-timing"], /(?:^|,\s*)upstream;dur=\d+(?:\.\d+)?(?:,|$)/);
  assert.ok(res.headers["access-control-expose-headers"].toLowerCase().split(/\s*,\s*/).includes("server-timing"));
});

test("rejects unlisted paths instead of proxying arbitrary routes", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  let calls = 0;
  global.fetch = async () => { calls++; };

  const res = makeResponse();
  await handler(makeRequest({ path: ["admin", "keys"], headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
  } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(calls, 0);
});

test("rejects request bodies above the fixed ingress size limit", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; };

  const res = makeResponse();
  const body = `{"data":"${"x".repeat(4_400_001)}"}`;
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body }), res);

  assert.equal(res.statusCode, 413);
  assert.equal(calls, 0);
});

test("accepts a conversation larger than the old 1 MB cap and forwards decompressed gzip and zstd JSON", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const input = "history ".repeat(150000);
  const raw = Buffer.from(JSON.stringify({ input, model: "gpt-6.1-sol" }));
  assert.ok(raw.length > 1_000_000);
  const observed = [];
  let reservations = 0;
  const localHandler = proxyModule.createHandler({ isConfigured: () => true,
    reserve: async () => { reservations++; return { ok: true, reservation: null }; }, release: async () => {} });
  global.fetch = async (_url, options) => { observed.push(options); return successfulResponse(); };
  for (const [encoding, body] of [["identity", raw], ["gzip", gzipSync(raw)], ["zstd", zstdCompressSync(raw)]]) {
    const res = makeResponse();
    await localHandler(makeRequest({ headers: { authorization: "Bearer kly_" + "a".repeat(43),
      "content-type": "application/json", "content-encoding": encoding, "content-length": String(body.length) }, body }), res);
    assert.equal(res.statusCode, 200, `${encoding}: ${res.body}`);
    const forwarded = observed.at(-1);
    assert.equal(JSON.parse(forwarded.body).input[0].content[0].text, input);
    assert.equal(forwarded.headers.get("content-encoding"), null, "upstream JSON must not retain the incoming compression header");
  }
  assert.equal(observed.length, 3);
  assert.equal(reservations, 3);
});

test("invalid or unsupported compressed bodies fail before reserving quota or contacting the provider", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let reservations = 0;
  let calls = 0;
  const localHandler = proxyModule.createHandler({ isConfigured: () => true,
    reserve: async () => { reservations++; return { ok: true, reservation: null }; }, release: async () => {} });
  global.fetch = async () => { calls++; throw new Error("Must not reach provider"); };
  for (const [encoding, body, status] of [["gzip", Buffer.from("broken"), 400], ["gzip, br", Buffer.from("{}"), 415],
    ["gzip", gzipSync(Buffer.alloc(MAX_DECODED_BYTES + 1, 120)), 413]]) {
    const res = makeResponse();
    await localHandler(makeRequest({ headers: { authorization: "Bearer kly_" + "a".repeat(43),
      "content-type": "application/json", "content-encoding": encoding }, body }), res);
    assert.equal(res.statusCode, status);
  }
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
});

test("rejects output limits above the configured ceiling", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  process.env.MAX_OUTPUT_TOKENS = "2048";
  let calls = 0;
  global.fetch = async () => { calls++; };

  const res = makeResponse();
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","input":"hello","max_output_tokens":10000}' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("forwards explicit large output limits across all supported request formats when no cap is configured", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const token = "kly_" + "p".repeat(43);
  const cases = [
    { path: "v1/responses", payload: { input: "hello", max_output_tokens: 32768 } },
    { path: "v1/chat/completions", payload: { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 32768 } },
    { path: "v1/chat/completions", payload: { messages: [{ role: "user", content: "hello" }], max_tokens: 32768 } },
    { path: "v1/messages", payload: { messages: [{ role: "user", content: "hello" }], max_tokens: 32768 } },
  ];
  const forwarded = [];
  global.fetch = async (_url, options) => {
    forwarded.push(JSON.parse(options.body));
    return successfulResponse();
  };
  for (const item of cases) {
    const res = makeResponse();
    await handler(makeRequest({ path: item.path, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: JSON.stringify(item.payload) }), res);
    assert.equal(res.statusCode, 200, item.path + ": " + res.body);
  }
  assert.equal(forwarded.length, cases.length);
  assert.ok(forwarded.every((payload) => payload.max_output_tokens === 32768));
});

test("uses a configurable output default only when the client omits a limit and bounds it by an optional cap", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const token = "kly_" + "p".repeat(43);
  const forwarded = [];
  global.fetch = async (_url, options) => {
    forwarded.push(JSON.parse(options.body).max_output_tokens);
    return successfulResponse();
  };
  const check = async (payload = { input: "hello" }) => {
    const res = makeResponse();
    await handler(makeRequest({ headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: JSON.stringify(payload) }), res);
    assert.equal(res.statusCode, 200, res.body);
  };
  await check();
  process.env.DEFAULT_OUTPUT_TOKENS = "4096";
  await check();
  process.env.MAX_OUTPUT_TOKENS = "3072";
  await check();
  await check({ input: "hello", max_output_tokens: 1024 });
  process.env.DEFAULT_OUTPUT_TOKENS = "32768";
  process.env.MAX_OUTPUT_TOKENS = "65536";
  await check({ input: "hello", max_output_tokens: 49152 });
  await check();
  assert.deepEqual(forwarded, [2048, 4096, 3072, 1024, 49152, 32768]);
});

test("rejects invalid explicit token limits without contacting the provider", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };
  for (const limit of [0, -1, 1.5, "32768"]) {
    for (const request of [
      { path: "v1/responses", payload: { input: "hello", max_output_tokens: limit } },
      { path: "v1/chat/completions", payload: { messages: [{ role: "user", content: "hello" }], max_completion_tokens: limit } },
      { path: "v1/chat/completions", payload: { messages: [{ role: "user", content: "hello" }], max_tokens: limit } },
      { path: "v1/messages", payload: { messages: [{ role: "user", content: "hello" }], max_tokens: limit } },
    ]) {
      const res = makeResponse();
      await handler(makeRequest({ path: request.path, headers: {
        authorization: "Bearer kly_" + "p".repeat(43), "content-type": "application/json",
      }, body: JSON.stringify(request.payload) }), res);
      assert.equal(res.statusCode, 400, `${request.path} accepted ${JSON.stringify(limit)}`);
    }
  }
  assert.equal(calls, 0);
});

test("fails closed for invalid configured output defaults or caps", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };
  for (const name of ["DEFAULT_OUTPUT_TOKENS", "MAX_OUTPUT_TOKENS"]) {
    for (const value of ["0", "-1", "1.5", "invalid", "9007199254740992"]) {
      delete process.env.DEFAULT_OUTPUT_TOKENS;
      delete process.env.MAX_OUTPUT_TOKENS;
      process.env[name] = value;
      const res = makeResponse();
      await handler(makeRequest({ headers: {
        authorization: "Bearer kly_" + "p".repeat(43), "content-type": "application/json",
      }, body: '{"input":"hello","max_output_tokens":32}' }), res);
      assert.equal(res.statusCode, 503, name + "=" + value + ": " + res.body);
    }
  }
  assert.equal(calls, 0);
});

test("rejects conflicting Chat token limit fields without contacting the provider", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };
  const res = makeResponse();
  await handler(makeRequest({ path: "v1/chat/completions", headers: {
    authorization: "Bearer kly_" + "p".repeat(43), "content-type": "application/json",
  }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 1024, max_completion_tokens: 2048 }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("translates Chat Completions and its legacy token limit into Responses and back", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let forwardedBody;
  global.fetch = async (_url, options) => {
    forwardedBody = options.body;
    return successfulResponse();
  };

  const res = makeResponse();
  await handler(makeRequest({ path: ["v1", "chat", "completions"], headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"hello"}],"max_tokens":300}' }), res);

  const upstream = JSON.parse(forwardedBody);
  assert.equal(upstream.max_output_tokens, 300);
  assert.equal(upstream.max_tokens, undefined);
  assert.equal(upstream.max_completion_tokens, undefined);
  assert.equal(upstream.input[0].content[0].text, "hello");
  const completion = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.choices[0].message.role, "assistant");
  assert.equal(completion.choices[0].message.content, "OK");
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.equal(completion.usage.total_tokens, 5);
});

test("serves the registered model locally after reserving the caller's minute quota", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let providerCalls = 0;
  global.fetch = async () => { providerCalls++; throw new Error("Model discovery must not call the provider"); };
  const reservations = [];
  const modelHandler = handler.createHandler({ isConfigured: () => true,
    reserve: async (token, options) => {
      reservations.push({ token, options });
      return { ok: true, reservation: null };
    }, release: async () => { throw new Error("Model discovery does not reserve daily quota"); } });

  const res = makeResponse();
  await modelHandler(makeRequest({ method: "GET", path: "v1/models", headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
  } }), res);

  assert.equal(providerCalls, 0);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].token, process.env.PROXY_ACCESS_TOKEN);
  assert.equal(reservations[0].options.consumeDaily, false);
  assert.equal(res.statusCode, 200);
  const catalog = JSON.parse(res.body);
  assert.equal(catalog.object, "list");
  assert.deepEqual(catalog.data.map((model) => model.id), ["gpt-6.1-sol"]);
  assert.equal(catalog.data[0].object, "model");
  assert.match(res.headers["server-timing"], /(?:^|,\s*)quota;dur=\d+(?:\.\d+)?(?:,|$)/);
  assert.doesNotMatch(res.headers["server-timing"], /upstream/);
});

test("routes each configured model to its own server credential across supported APIs and shared account quotas", async () => {
  process.env.XINGCHI_API_KEY = "legacy-sol-secret";
  process.env.XINGCHI_SOL_API_KEY = "dedicated-sol-secret";
  process.env.XINGCHI_ASTRA_API_KEY = "astra-only-secret";
  const token = "kly_" + "k".repeat(43);
  const reservations = [];
  const dispatch = handler.createHandler({ isConfigured: () => true,
    reserve: async (key, options) => { reservations.push({ key, options }); return { ok: true, reservation: null }; },
    release: async () => {} });
  const seen = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    seen.push({ model: payload.model, credential: options.headers.get("authorization") });
    return new Response(JSON.stringify({ ...responseFixture(), model: payload.model }), { headers: { "content-type": "application/json" } });
  };
  const paths = ["v1/responses", "v1/chat/completions", "v1/messages"];
  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    for (const path of paths) {
      const payload = path === "v1/responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }], max_tokens: 16 };
      const res = makeResponse();
      await dispatch(makeRequest({ path, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...payload, model }) }), res);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(JSON.parse(res.body).model, model, `response model for ${path}`);
      assert.equal(res.body.includes("secret"), false);
    }
  }
  assert.deepEqual(seen, [
    ...Array.from({ length: 3 }, () => ({ model: "gpt-6.1-sol", credential: "Bearer dedicated-sol-secret" })),
    ...Array.from({ length: 3 }, () => ({ model: "gpt-6-astra", credential: "Bearer astra-only-secret" })),
  ]);
  assert.equal(reservations.length, 6);
  assert.ok(reservations.every(({ key, options }) => key === token && options.consumeDaily === true));
});

test("Astra streams preserve the selected model in Chat and Anthropic protocol adapters", async () => {
  process.env.XINGCHI_ASTRA_API_KEY = "astra-only-secret";
  process.env.UPSTREAM_AUTH_MODE = "x-api-key";
  const model = "gpt-6-astra";
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.headers.get("x-api-key"), "astra-only-secret");
    assert.equal(options.headers.get("authorization"), null);
    assert.equal(JSON.parse(options.body).model, model);
    return new Response(eventFrame({ type: "response.completed", response: { ...responseFixture(), model } }), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  for (const path of ["v1/chat/completions", "v1/messages"]) {
    const res = makeResponse();
    await handler(makeRequest({ path, headers: { authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 16 }) }), res);
    assert.equal(res.statusCode, 200);
    const data = res.body.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
    const models = data.flatMap((item) => item.model ? [item.model] : item.message?.model ? [item.message.model] : []);
    assert.ok(models.length > 0);
    assert.ok(models.every((id) => id === model));
  }
  assert.equal(calls, 2);
});

test("catalog lists only configured model IDs and omitting model still defaults to Sol", async () => {
  process.env.XINGCHI_API_KEY = "fallback-sol-secret";
  process.env.XINGCHI_ASTRA_API_KEY = "astra-only-secret";
  const headers = { authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json" };
  let seen;
  global.fetch = async (_url, options) => { seen = { credential: options.headers.get("authorization"), payload: JSON.parse(options.body) }; return successfulResponse(); };
  const defaulted = makeResponse();
  await handler(makeRequest({ headers }), defaulted);
  assert.equal(defaulted.statusCode, 200);
  assert.equal(seen.credential, "Bearer fallback-sol-secret");
  assert.equal(seen.payload.model, "gpt-6.1-sol");
  const both = makeResponse();
  await handler(makeRequest({ method: "GET", path: "v1/models", headers }), both);
  assert.deepEqual(JSON.parse(both.body).data.map(({ id }) => id), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.equal(both.body.includes("secret"), false);
  delete process.env.XINGCHI_API_KEY;
  const astra = makeResponse();
  await handler(makeRequest({ method: "GET", path: "v1/models", headers }), astra);
  assert.deepEqual(JSON.parse(astra.body).data.map(({ id }) => id), ["gpt-6-astra"]);
  const missingDefault = makeResponse();
  await handler(makeRequest({ headers }), missingDefault);
  assert.equal(missingDefault.statusCode, 503, "Astra cannot silently replace an omitted Sol model");
});

test("unknown, malformed and unconfigured model selections never call or spend the other model's credential", async () => {
  process.env.XINGCHI_API_KEY = "fallback-sol-secret";
  let calls = 0;
  let reservations = 0;
  global.fetch = async () => { calls++; throw new Error("must not call provider"); };
  const dispatch = handler.createHandler({ isConfigured: () => true, reserve: async () => { reservations++; return { ok: true }; } });
  for (const model of ["gpt-6-astra", "gpt-6.1-astra", "__proto__", null, false, "", ["gpt-6.1-sol"], { id: "gpt-6.1-sol" }]) {
    const res = makeResponse();
    await dispatch(makeRequest({ headers: { authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json" },
      body: JSON.stringify({ model, input: "hello" }) }), res);
    assert.equal(res.statusCode, model === "gpt-6-astra" ? 503 : 400);
    assert.equal(res.body.includes("fallback-sol-secret"), false);
  }
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
});

test("local model discovery still rejects an invalid or exhausted API key", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let providerCalls = 0;
  global.fetch = async () => { providerCalls++; throw new Error("must not be called"); };
  for (const refusal of [
    { ok: false, status: 401, message: "Invalid API key" },
    { ok: false, status: 429, message: "Minute quota exceeded", retryAfter: 15 },
  ]) {
    const modelHandler = handler.createHandler({ isConfigured: () => true,
      reserve: async (_token, options) => {
        assert.equal(options.consumeDaily, false);
        return refusal;
      } });
    const res = makeResponse();
    await modelHandler(makeRequest({ method: "GET", path: ["v1", "models"], headers: {
      authorization: "Bearer kly_" + "k".repeat(43),
    } }), res);
    assert.equal(res.statusCode, refusal.status);
    assert.equal(JSON.parse(res.body).error, refusal.message);
    if (refusal.retryAfter) assert.equal(res.headers["retry-after"], "15");
  }
  assert.equal(providerCalls, 0);
});

test("forwards Responses events before the upstream generation finishes", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const created = { type: "response.created", response: { ...responseFixture(), status: "in_progress", output: [] } };
  const delta = { type: "response.output_text.delta", item_id: "msg_test", output_index: 0,
    content_index: 0, delta: "OK" };
  const completed = { type: "response.completed", response: responseFixture() };
  const firstChunk = eventFrame(created);
  const lastChunk = Buffer.concat([eventFrame(delta), eventFrame(completed)]);
  let streamController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(firstChunk);
    },
  });
  global.fetch = async () => new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });

  const res = makeResponse();
  let signalFirstWrite;
  const firstWrite = new Promise((resolve) => { signalFirstWrite = resolve; });
  const originalWrite = res.write.bind(res);
  res.write = (chunk) => {
    const result = originalWrite(chunk);
    signalFirstWrite();
    return result;
  };
  const runningHandler = handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","input":"hello","stream":true}' }), res);

  let writeTimeout;
  let closed = false;
  try {
    await Promise.race([
      firstWrite,
      new Promise((_, reject) => {
        writeTimeout = setTimeout(() => reject(new Error("First stream chunk was buffered")), 1500);
      }),
    ]);
    assert.deepEqual(res.writtenChunks, [firstChunk]);
    assert.equal(res.ended, undefined);
    streamController.enqueue(lastChunk);
    streamController.close();
    closed = true;
    await runningHandler;

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /^text\/event-stream/);
    assert.deepEqual(res.writtenChunks, [firstChunk, eventFrame(delta), eventFrame(completed)]);
    assert.equal(res.body, Buffer.concat([firstChunk, lastChunk]).toString("utf8"));
    assert.equal(res.ended, true);
  } finally {
    clearTimeout(writeTimeout);
    if (!closed) streamController.close();
    await runningHandler;
  }
});

test("preserves the upstream JSON error status, body and retry header", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const upstreamError = '{"error":{"type":"rate_limit_error","message":"Quota exceeded"}}';
  global.fetch = async () => new Response(upstreamError, {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "7" },
  });

  const res = makeResponse();
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  } }), res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body, upstreamError);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["retry-after"], "7");
});

test("answers browser preflight without credentials or an upstream request", async () => {
  delete process.env.PROXY_ACCESS_TOKEN;
  delete process.env.XINGCHI_API_KEY;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };

  const res = makeResponse();
  await handler(makeRequest({ method: "OPTIONS", path: "v1/messages", headers: {
    origin: "https://client.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type,x-api-key,x-proxy-key",
  } }), res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  const allowedMethods = res.headers["access-control-allow-methods"].split(/\s*,\s*/);
  for (const method of ["GET", "POST", "OPTIONS"]) assert.ok(allowedMethods.includes(method));
  const allowedHeaders = res.headers["access-control-allow-headers"].toLowerCase().split(/\s*,\s*/);
  for (const name of ["authorization", "content-type", "x-api-key", "x-proxy-key"]) {
    assert.ok(allowedHeaders.includes(name));
  }
  assert.equal(res.body, "");
  assert.equal(calls, 0);
});

test("accepts a personal key and reserves its generation quota before forwarding", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const token = "kly_" + "k".repeat(43);
  const sequence = [];
  const personalHandler = handler.createHandler({
    isConfigured: () => true,
    reserve: async (key, options) => {
      assert.equal(key, token);
      assert.equal(options.consumeDaily, true);
      sequence.push("reserve");
      return { ok: true, reservation: { id: "reservation-1" } };
    },
    settle: async (_reservation, usage) => {
      assert.deepEqual(usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
      sequence.push("settle");
    },
    release: async () => { throw new Error("Successful calls must keep their quota"); },
  });
  global.fetch = async () => {
    sequence.push("upstream");
    return successfulResponse();
  };
  const res = makeResponse();
  await personalHandler(makeRequest({ path: "v1/responses", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","input":"hello"}' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sequence, ["reserve", "upstream", "settle"]);
});

test("stops an exhausted personal key without spending upstream quota", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; };
  const personalHandler = handler.createHandler({
    isConfigured: () => true,
    reserve: async () => ({ ok: false, status: 429, message: "Daily quota exceeded", retryAfter: 60 }),
  });
  const res = makeResponse();
  await personalHandler(makeRequest({ path: "v1/responses", headers: {
    authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json",
  }, body: '{"input":"hello"}' }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "60");
  assert.equal(calls, 0);
});

test("refunds personal daily quota when the provider denies a request", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const released = [];
  global.fetch = async () => new Response('{"error":{"code":"client_not_allowed"}}', { status: 403 });
  const personalHandler = handler.createHandler({
    isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "request-2" } }),
    release: async (reservation) => released.push(reservation.id),
  });
  const res = makeResponse();
  await personalHandler(makeRequest({ path: "v1/responses", headers: {
    authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json",
  }, body: '{"input":"hello"}' }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(released, ["request-2"]);
});

test("fails closed if the quota database is unavailable", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; };
  const personalHandler = handler.createHandler({
    isConfigured: () => true,
    reserve: async () => { throw new Error("Redis unavailable"); },
  });
  const res = makeResponse();
  await personalHandler(makeRequest({ method: "GET", path: "v1/models", headers: {
    authorization: "Bearer kly_" + "k".repeat(43),
  } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
});

test("translates Anthropic messages into Responses and returns an Anthropic message", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let observed;
  global.fetch = async (url, options) => {
    observed = { url, payload: JSON.parse(options.body) };
    return successfulResponse();
  };

  const res = makeResponse();
  await handler(makeRequest({ path: "v1/messages", headers: {
    "x-api-key": process.env.PROXY_ACCESS_TOKEN,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  }, body: JSON.stringify({ model: "gpt-6.1-sol", system: "Be concise.", max_tokens: 128,
    messages: [{ role: "user", content: "hello" }] }) }), res);

  assert.equal(observed.url, "https://api.xingchiapi.com/v1/responses");
  assert.equal(observed.payload.instructions, "Be concise.");
  assert.equal(observed.payload.max_output_tokens, 128);
  assert.equal(observed.payload.stream, true);
  assert.equal(observed.payload.input[0].role, "user");
  const message = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [{ type: "text", text: "OK" }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(message.usage, { input_tokens: 3, output_tokens: 2 });
});

test("collects an upstream Responses stream for a client that requested plain JSON", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const frames = [
    eventFrame({ type: "response.created", response: { ...responseFixture(), status: "in_progress", output: [] } }),
    eventFrame({ type: "response.output_text.delta", item_id: "msg_test", content_index: 0, output_index: 0, delta: "OK" }),
    eventFrame({ type: "response.completed", response: responseFixture() }),
  ];
  global.fetch = async () => new Response(Buffer.concat(frames), {
    headers: { "content-type": "text/event-stream" },
  });
  const res = makeResponse();
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`, "content-type": "application/json",
  } }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), responseFixture());
  assert.equal(res.writtenChunks.length, 1);
});

test("reports a truncated generation stream instead of manufacturing completion", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  global.fetch = async () => new Response(eventFrame({ type: "response.created", response: {
    ...responseFixture(), status: "in_progress", output: [],
  } }), { headers: { "content-type": "text/event-stream" } });
  const res = makeResponse();
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`, "content-type": "application/json",
  }, body: '{"input":"hello","stream":true}' }), res);

  assert.equal(res.ended, true);
  assert.match(res.body, /"error"/);
  assert.doesNotMatch(res.body, /response\.completed|\[DONE\]/);
});

test("rejects unavailable models and multiple outputs without an upstream request", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };
  for (const payload of [{ input: "hello", model: "other-model" }, { input: "hello", n: 2 }]) {
    const res = makeResponse();
    await handler(makeRequest({ headers: {
      authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`, "content-type": "application/json",
    }, body: JSON.stringify(payload) }), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("a slow nonstream provider sends valid JSON keepalive before returning the final response", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let finishFetch;
  global.fetch = async () => new Promise((resolve) => { finishFetch = resolve; });
  const slowHandler = proxyModule.createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: null }), release: async () => {} }, { keepaliveIntervalMs: 5 });
  const res = makeResponse();
  let firstWrite;
  const first = new Promise((resolve) => { firstWrite = resolve; });
  const originalWrite = res.write.bind(res);
  res.write = (chunk) => { const result = originalWrite(chunk); firstWrite(); return result; };
  const running = slowHandler(makeRequest({ headers: {
    authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json",
  } }), res);
  await first;
  assert.equal(res.statusCode, 200);
  assert.equal(res.writtenChunks[0].toString(), "\n ");
  finishFetch(successfulResponse("delayed OK"));
  await running;
  assert.equal(JSON.parse(res.body).output[0].content[0].text, "delayed OK");
});

test("accounting storage failure never hides the original upstream HTTP error", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const originalError = '{"error":{"code":"overloaded","message":"Retry later"}}';
  for (const status of [403, 503]) {
  global.fetch = async () => new Response(originalError, { status, headers: { "content-type": "application/json" } });
  const failureHandler = proxyModule.createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "refund-ticket" } }),
    markUnknown: async () => { throw new Error("storage unavailable"); },
    release: async () => { throw new Error("storage unavailable"); } });
  const res = makeResponse();
  await failureHandler(makeRequest({ headers: {
    authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json",
  } }), res);
  assert.equal(res.statusCode, status);
  assert.equal(res.headers["x-klyapi-error-source"], "upstream");
  assert.equal(res.body, originalError);
  }
});

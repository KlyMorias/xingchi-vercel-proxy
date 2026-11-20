const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

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

test("rejects request bodies above the fixed size limit", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; };

  const res = makeResponse();
  const body = `{"data":"${"x".repeat(1_000_001)}"}`;
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body }), res);

  assert.equal(res.statusCode, 413);
  assert.equal(calls, 0);
});

test("rejects output limits above the configured ceiling", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "a".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; };

  const res = makeResponse();
  await handler(makeRequest({ headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","messages":[],"max_tokens":10000}' }), res);

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

test("accepts a slash-separated query path produced by Vercel rewrites", async () => {
  process.env.PROXY_ACCESS_TOKEN = "kly_" + "p".repeat(43);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return new Response('{"data":[]}', {
      headers: { "content-type": "application/json" },
    });
  };

  const res = makeResponse();
  await handler(makeRequest({ method: "GET", path: "v1/models", headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
  } }), res);

  assert.equal(requestedUrl, "https://api.xingchiapi.com/v1/models");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"data":[]}');
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
  assert.deepEqual(sequence, ["reserve", "upstream"]);
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

test("refund storage failure never hides the original upstream HTTP error", async () => {
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const originalError = '{"error":{"code":"overloaded","message":"Retry later"}}';
  global.fetch = async () => new Response(originalError, { status: 503, headers: { "content-type": "application/json" } });
  const failureHandler = proxyModule.createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "refund-ticket" } }),
    release: async () => { throw new Error("storage unavailable"); } });
  const res = makeResponse();
  await failureHandler(makeRequest({ headers: {
    authorization: "Bearer kly_" + "k".repeat(43), "content-type": "application/json",
  } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["x-klyapi-error-source"], "upstream");
  assert.equal(res.body, originalError);
});

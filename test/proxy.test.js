const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const handler = require("../api/proxy.js");

function makeRequest({ method = "POST", path = ["v1", "messages"], headers = {}, body = "{}" } = {}) {
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
    },
    once: events.once.bind(events),
  };
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
test.afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("rejects unauthorized callers without contacting Xingchi", async () => {
  process.env.PROXY_ACCESS_TOKEN = "a".repeat(40);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not be called"); };

  const res = makeResponse();
  await handler(makeRequest({ headers: { "content-type": "application/json" } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test("forwards an allowed message route with server-side credentials", async () => {
  process.env.PROXY_ACCESS_TOKEN = "p".repeat(40);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  process.env.UPSTREAM_AUTH_MODE = "x-api-key";
  let observed;
  global.fetch = async (url, options) => {
    observed = { url, options };
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  };

  const res = makeResponse();
  await handler(makeRequest({
    headers: {
      authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "client-token",
    },
    body: '{"model":"gpt-6.1-sol","messages":[]}',
  }), res);

  assert.equal(observed.url, "https://api.xingchiapi.com/v1/messages");
  assert.equal(observed.options.headers.get("x-api-key"), "upstream-secret");
  assert.equal(observed.options.headers.get("authorization"), null);
  assert.equal(observed.options.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(observed.options.body, '{"model":"gpt-6.1-sol","messages":[],"max_tokens":2048}');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(res.body.includes("upstream-secret"), false);
});

test("rejects unlisted paths instead of proxying arbitrary routes", async () => {
  process.env.PROXY_ACCESS_TOKEN = "a".repeat(40);
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
  process.env.PROXY_ACCESS_TOKEN = "a".repeat(40);
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
  process.env.PROXY_ACCESS_TOKEN = "a".repeat(40);
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

test("preserves legacy OpenAI max_tokens without adding another limit field", async () => {
  process.env.PROXY_ACCESS_TOKEN = "p".repeat(40);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  let forwardedBody;
  global.fetch = async (_url, options) => {
    forwardedBody = options.body;
    return new Response("{}", { status: 200 });
  };

  const res = makeResponse();
  await handler(makeRequest({ path: ["v1", "chat", "completions"], headers: {
    authorization: `Bearer ${process.env.PROXY_ACCESS_TOKEN}`,
    "content-type": "application/json",
  }, body: '{"model":"gpt-6.1-sol","messages":[],"max_tokens":300}' }), res);

  assert.equal(forwardedBody, '{"model":"gpt-6.1-sol","messages":[],"max_tokens":300}');
});

test("accepts a slash-separated query path produced by Vercel rewrites", async () => {
  process.env.PROXY_ACCESS_TOKEN = "p".repeat(40);
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

test("forwards event stream chunks before the upstream stream finishes", async () => {
  process.env.PROXY_ACCESS_TOKEN = "p".repeat(40);
  process.env.XINGCHI_API_KEY = "upstream-secret";
  const firstChunk = Buffer.from('data: {"delta":"hello"}\n\n');
  const lastChunk = Buffer.from("data: [DONE]\n\n");
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
  }, body: '{"model":"gpt-6.1-sol","messages":[],"stream":true}' }), res);

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
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.deepEqual(res.writtenChunks, [firstChunk, lastChunk]);
    assert.equal(res.body, Buffer.concat([firstChunk, lastChunk]).toString("utf8"));
    assert.equal(res.ended, true);
  } finally {
    clearTimeout(writeTimeout);
    if (!closed) streamController.close();
    await runningHandler;
  }
});

test("preserves the upstream JSON error status, body and retry header", async () => {
  process.env.PROXY_ACCESS_TOKEN = "p".repeat(40);
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
    return new Response("{}", { status: 200 });
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const handler = require("../api/[...path].js");

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
    body: '{"model":"example","messages":[]}',
  }), res);

  assert.equal(observed.url, "https://api.xingchiapi.com/v1/messages");
  assert.equal(observed.options.headers.get("x-api-key"), "upstream-secret");
  assert.equal(observed.options.headers.get("authorization"), null);
  assert.equal(observed.options.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(observed.options.body, '{"model":"example","messages":[],"max_tokens":2048}');
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
  }, body: '{"model":"example","messages":[],"max_tokens":10000}' }), res);

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
  }, body: '{"model":"example","messages":[],"max_tokens":300}' }), res);

  assert.equal(forwardedBody, '{"model":"example","messages":[],"max_tokens":300}');
});

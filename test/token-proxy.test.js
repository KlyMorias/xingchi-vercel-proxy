const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/proxy");
const { estimatedTokens, actualTokens } = require("../lib/token-usage");

const env = { ...process.env };
const originalFetch = global.fetch;
test.beforeEach(() => { process.env.XINGCHI_SOL_API_KEY = "test-provider-secret"; });
test.afterEach(() => { process.env = { ...env }; global.fetch = originalFetch; });

function terminal(extra = {}) {
  return { object: "response", id: "resp_token_test", status: "completed", model: "gpt-6.1-sol",
    output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }] }],
    usage: { input_tokens: 17, output_tokens: 11, total_tokens: 28,
      input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 6 } }, ...extra };
}
function request(path, stream = false) {
  const payload = path === "v1/responses" ? { input: "Merhaba 世界", max_output_tokens: 128 }
    : { messages: [{ role: "user", content: "Merhaba 世界" }], max_tokens: 128 };
  return { method: "POST", query: { path }, headers: { authorization: `Bearer kly_${"T".repeat(43)}`,
    "content-type": "application/json" },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...payload, model: "gpt-6.1-sol", stream })); } };
}
function sink(onWrite = () => {}) {
  return { headers: {}, chunks: [], setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { onWrite(String(chunk)); this.headersSent = true; this.chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.body = this.chunks.join(""); this.writableEnded = true; } };
}

test("admission budget includes UTF8 input and the full requested output ceiling", () => {
  const body = JSON.stringify({ input: "世界", max_output_tokens: 256 });
  assert.equal(estimatedTokens(body), Buffer.byteLength(body) + 256);
  assert.equal(estimatedTokens(body, 256), estimatedTokens(body));
  for (const ceiling of [0, -1, 0.5, NaN, Infinity, "256"]) {
    assert.throws(() => estimatedTokens(body, ceiling), /token budget is invalid/);
  }
  assert.deepEqual(actualTokens(terminal()), { input_tokens: 17, output_tokens: 11, total_tokens: 28 });
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 0.5 }]) {
    assert.throws(() => actualTokens({ usage }), /valid token usage/);
  }
});

test("disconnect during quota reservation refunds the hold without starting the provider", async () => {
  for (const disconnect of ["request", "response"]) {
    const req = request("v1/responses");
    const res = sink();
    let released = 0;
    global.fetch = async () => assert.fail("Disconnected client must not start provider work");
    const dispatch = createHandler({
      isConfigured: () => true,
      reserve: async () => {
        if (disconnect === "request") req.aborted = true;
        else res.destroyed = true;
        return { ok: true, reservation: { id: "held" } };
      },
      release: async (reservation) => { assert.equal(reservation.id, "held"); released++; },
      settle: async () => assert.fail("No generation completed"),
    });
    await dispatch(req, res);
    assert.equal(released, 1);
    assert.equal(res.writableEnded, undefined);
  }
});

for (const path of ["v1/responses", "v1/chat/completions", "v1/messages"]) {
  for (const stream of [false, true]) {
    test(`${path} ${stream ? "SSE" : "JSON"} settles actual input plus output before completion`, async () => {
      const calls = [];
      let settled = false;
      const dispatch = createHandler({ isConfigured: () => true,
        reserve: async (_token, options) => { calls.push("reserve"); assert.ok(options.estimatedTokens > 128); return { ok: true, reservation: { id: "test" } }; },
        settle: async (reservation, usage) => { assert.equal(reservation.id, "test"); assert.deepEqual(usage, { input_tokens: 17, output_tokens: 11, total_tokens: 28 }); calls.push("settle"); settled = true; },
        release: async () => assert.fail("Successful usage must not be refunded") });
      global.fetch = async () => {
        calls.push("fetch");
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: terminal() })}\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      };
      const res = sink(frame => { if (/response.completed|finish_reason|message_stop/.test(frame)) assert.equal(settled, true); });
      await dispatch(request(path, stream), res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(calls, ["reserve", "fetch", "settle"]);
      assert.ok(res.writableEnded);
      assert.doesNotMatch(res.body, /token_accounting_unavailable/);
    });
  }
}

test("a completed response with output cutoff still settles its real usage", async () => {
  let usage;
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async (_reservation, value) => { usage = value; }, release: async () => assert.fail() });
  global.fetch = async () => new Response(JSON.stringify(terminal({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })),
    { headers: { "content-type": "application/json" } });
  const res = sink();
  await dispatch(request("v1/responses"), res);
  assert.equal(usage.total_tokens, 28);
  assert.equal(JSON.parse(res.body).status, "incomplete");
});

test("accounting failure cannot emit successful completion or refund generated tokens", async () => {
  let released = false;
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async () => { throw new Error("storage failure"); }, release: async () => { released = true; } });
  global.fetch = async () => new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  const res = sink();
  await dispatch(request("v1/responses", true), res);
  assert.equal(released, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["x-klyapi-error-source"], "quota_storage");
  assert.match(res.body, /Token accounting is temporarily unavailable/);
  assert.doesNotMatch(res.body, /response.completed/);
});

test("upstream failure releases the token hold and never settles usage", async () => {
  const calls = [];
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async () => assert.fail(), release: async () => { calls.push("release"); } });
  global.fetch = async () => new Response('{"error":"provider down"}', { status: 503 });
  const res = sink();
  await dispatch(request("v1/responses"), res);
  assert.deepEqual(calls, ["release"]);
  assert.equal(res.statusCode, 503);
});

test("known complete JSON usage is settled even when an SSE client disconnects on the first frame", async () => {
  let settled = 0;
  let refunded = 0;
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async () => { settled++; }, release: async () => { refunded++; } });
  global.fetch = async () => new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  const res = sink(() => { throw new Error("Client disconnected"); });
  await dispatch(request("v1/responses", true), res);
  assert.equal(settled, 1);
  assert.equal(refunded, 0);
  assert.doesNotMatch(res.body, /Token accounting/);
});

test("a transient settlement failure retries the same ticket before delivering success", async () => {
  let attempts = 0;
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "same-ticket" } }),
    settle: async (reservation) => { assert.equal(reservation.id, "same-ticket"); if (++attempts === 1) throw new Error("lost acknowledgement"); },
    release: async () => assert.fail() });
  global.fetch = async () => new Response(JSON.stringify(terminal()), { headers: { "content-type": "application/json" } });
  const res = sink();
  await dispatch(request("v1/responses"), res);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(res.body).status, "completed");
});

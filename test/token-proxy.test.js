const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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
function request(path, stream = false, extra = {}) {
  const payload = path === "v1/responses" ? { input: "Merhaba 世界", max_output_tokens: 128 }
    : { messages: [{ role: "user", content: "Merhaba 世界" }], max_tokens: 128 };
  return { method: "POST", query: { path }, headers: { authorization: `Bearer kly_${"T".repeat(43)}`,
    "content-type": "application/json" },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...payload, model: "gpt-6.1-sol", stream, ...extra })); } };
}
function providerExtensionUsage() {
  return { input_tokens: 4230,
    input_tokens_details: { cached_tokens: 2786, cache_write_tokens: 0, cache_write_tokens_details: { type: "object" } },
    output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 4238,
    attribution: { items: { type: "object" }, request_fields: { type: "object" } } };
}
function sink(onWrite = () => {}) {
  const text = (chunk) => ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8") : String(chunk);
  return { headers: {}, chunks: [], setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { onWrite(text(chunk)); this.headersSent = true; this.chunks.push(text(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(text(chunk)); this.body = this.chunks.join(""); this.writableEnded = true; } };
}

test("admission budget includes UTF8 input and the full requested output ceiling", () => {
  const body = JSON.stringify({ input: "世界", max_output_tokens: 256 });
  assert.equal(estimatedTokens(body), Buffer.byteLength(body) + 256);
  assert.equal(estimatedTokens(body, 256), estimatedTokens(body));
  for (const ceiling of [0, -1, 0.5, NaN, Infinity, "256"]) {
    assert.throws(() => estimatedTokens(body, ceiling), /token budget is invalid/);
  }
  assert.deepEqual(actualTokens(terminal()), { input_tokens: 17, output_tokens: 11, total_tokens: 28 });
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 0.5 },
    { input_tokens: 1, output_tokens: 2, total_tokens: 99 }, { input_tokens: 1, output_tokens: 2, total_tokens: -3 },
    { input_tokens: 1, output_tokens: 2, total_tokens: "3" }, { input_tokens: 1, output_tokens: 2, total_tokens: null },
    { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 2 } },
    { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } },
    { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: -1 } },
    { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0.5 } },
    { input_tokens: 1, output_tokens: 2, input_tokens_details: [] }]) {
    assert.throws(() => actualTokens({ usage }), /valid token usage/);
  }
});

test("missing and inconsistent terminal usage never becomes success or a quota-storage error across APIs", async () => {
  for (const path of ["v1/responses", "v1/chat/completions", "v1/messages"]) {
    for (const stream of [false, true]) {
      for (const sse of [false, true]) {
        for (const usage of [undefined, { input_tokens: 17, output_tokens: 11, total_tokens: 999 },
          { input_tokens: 17, output_tokens: 11, input_tokens_details: { cached_tokens: 18 } }]) {
          let unknown = 0;
          const dispatch = createHandler({ isConfigured: () => true,
            reserve: async () => ({ ok: true, reservation: { id: "test" } }),
            settle: async () => assert.fail("Invalid provider usage cannot be charged"),
            release: async () => assert.fail("Unreported usage cannot be described as confirmed zero consumption"),
            markUnknown: async () => { unknown++; } });
          const response = terminal({ usage });
          global.fetch = async () => new Response(sse ? `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`
            : JSON.stringify(response), { headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
          const res = sink();
          await dispatch(request(path, stream), res);
          assert.equal(res.statusCode, 502);
          assert.equal(res.headers["x-klyapi-error-source"], "upstream_usage");
          assert.match(res.body, /invalid_token_usage/);
          assert.doesNotMatch(res.body, /quota_storage|response.completed|message_stop|finish_reason/);
          assert.equal(unknown, 1);
        }
      }
    }
  }
});

test("structured provider usage extensions preserve strict real counts without adding consumption", () => {
  const usage = providerExtensionUsage();
  const before = structuredClone(usage);
  assert.deepEqual(actualTokens({ usage }), { input_tokens: 4230, output_tokens: 8, total_tokens: 4238 });
  assert.deepEqual(usage, before, "validation must not mutate provider metadata");
  for (const [field, counter, value] of [
    ["input_tokens_details", "cached_tokens", 4231],
    ["input_tokens_details", "cached_tokens", null],
    ["input_tokens_details", "cache_write_tokens", -1],
    ["input_tokens_details", "cache_write_tokens", { type: "object" }],
    ["output_tokens_details", "reasoning_tokens", 9],
    ["output_tokens_details", "reasoning_tokens", 0.5],
  ]) {
    const invalid = providerExtensionUsage();
    invalid[field][counter] = value;
    assert.throws(() => actualTokens({ usage: invalid }), { code: "invalid_token_usage" });
  }
  assert.throws(() => actualTokens({ usage: { ...usage, total_tokens: 4239 } }), { code: "invalid_token_usage" });
  assert.throws(() => actualTokens({ usage: { ...usage, input_tokens: "4230" } }), { code: "invalid_token_usage" });
});

test("real-shaped structured usage reconciles once across JSON, SSE and all supported protocols", async () => {
  for (const path of ["v1/responses", "v1/chat/completions", "v1/messages"]) {
    for (const stream of [false, true]) {
      for (const sse of [false, true]) {
        const response = terminal({ usage: providerExtensionUsage() });
        let settlements = 0;
        const dispatch = createHandler({ isConfigured: () => true,
          reserve: async () => ({ ok: true, reservation: { id: "test" } }),
          settle: async (_ticket, usage) => {
            assert.deepEqual(usage, { input_tokens: 4230, output_tokens: 8, total_tokens: 4238 });
            settlements++;
          },
          release: async () => assert.fail("Validated actual usage cannot be refunded"),
          markUnknown: async () => assert.fail("Structured optional metadata does not make real counts unknown") });
        global.fetch = async () => new Response(sse ? `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`
          : JSON.stringify(response), { headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
        const res = sink(frame => {
          if (/response.completed|finish_reason|message_stop/.test(frame)) assert.equal(settlements, 1);
        });
        await dispatch(request(path, stream, path === "v1/chat/completions" && stream
          ? { stream_options: { include_usage: true } } : {}), res);
        assert.equal(res.statusCode, 200);
        assert.equal(settlements, 1);
        assert.doesNotMatch(res.body, /invalid_token_usage|token_accounting_unavailable/);
        const payloads = stream ? res.body.split(/\r?\n\r?\n/).flatMap(block => {
          const data = block.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6);
          return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
        }) : [JSON.parse(res.body)];
        const delivered = payloads.find(value => path === "v1/responses"
          ? (value.type === "response.completed" || value.object === "response")
          : value.usage && (path === "v1/chat/completions" || !stream || value.type === "message_delta"));
        const usage = path === "v1/responses" && stream ? delivered.response.usage : delivered.usage;
        assert.equal(usage[path === "v1/chat/completions" ? "prompt_tokens" : "input_tokens"], 4230);
        assert.equal(usage[path === "v1/chat/completions" ? "completion_tokens" : "output_tokens"], 8);
        if (path !== "v1/messages") assert.equal(usage.total_tokens, 4238);
      }
    }
  }
});

test("valid provider usage on failed and cancelled terminals is recorded while generation still fails", async () => {
  for (const status of ["failed", "cancelled"]) {
    for (const sse of [false, true]) {
      for (const stream of [false, true]) {
        const calls = [];
        const dispatch = createHandler({ isConfigured: () => true,
          reserve: async () => ({ ok: true, reservation: { id: "test" } }),
          settle: async (_ticket, usage, details) => {
            assert.deepEqual(usage, { input_tokens: 17, output_tokens: 11, total_tokens: 28 });
            assert.deepEqual(details, { response_id: "resp_token_test", model: "gpt-6.1-sol" });
            calls.push("settle");
          },
          release: async () => assert.fail("Known generated usage must not be refunded"),
          markUnknown: async () => assert.fail("Valid recorded usage is known even when generation failed") });
        const response = terminal({ status, error: { message: "private provider diagnostic" } });
        global.fetch = async () => new Response(sse ? `data: ${JSON.stringify({ type: `response.${status}`, response })}\n\n`
          : JSON.stringify(response), { headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
        const res = sink();
        await dispatch(request("v1/responses", stream), res);
        assert.equal(res.statusCode, 502);
        assert.deepEqual(calls, ["settle"]);
        assert.doesNotMatch(res.body, /private provider diagnostic|response.completed/);
      }
    }
  }
});

test("uncertain client disconnect after partial output records unknown consumption without guessing", async () => {
  let unknown = 0;
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async () => assert.fail("No actual terminal usage is available"),
    release: async () => assert.fail("An aborted provider request is not proof of zero usage"),
    markUnknown: async () => { unknown++; } });
  global.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(Object.assign(new Error("Aborted"), { name: "AbortError" })));
      controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    },
  }), { headers: { "content-type": "text/event-stream" } });
  let res;
  res = Object.assign(new EventEmitter(), sink(() => { res.destroyed = true; res.emit("close"); }));
  await dispatch(Object.assign(new EventEmitter(), request("v1/responses", true)), res);
  assert.equal(unknown, 1);
});

test("a non-2xx provider error can report real usage without turning the generation into success", async () => {
  for (const nested of [false, true]) {
    let settled = 0;
    const dispatch = createHandler({ isConfigured: () => true,
      reserve: async () => ({ ok: true, reservation: { id: "test" } }),
      settle: async (_ticket, usage) => { settled++; assert.equal(usage.total_tokens, 28); },
      release: async () => assert.fail("A provider HTTP error does not erase reported token usage"),
      markUnknown: async () => assert.fail("This usage is known") });
    const response = terminal({ status: "failed", error: { code: "server_error", message: "Provider failed" } });
    global.fetch = async () => new Response(JSON.stringify(nested ? { error: { code: "server_error" }, response } : response),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "10" } });
    const res = sink();
    await dispatch(request("v1/responses"), res);
    assert.equal(settled, 1);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["x-klyapi-error-source"], "upstream");
    assert.equal(res.headers["retry-after"], "10");
    assert.match(res.body, /server_error/);
  }
});

test("known terminal usage survives presentation failures without reporting a successful generation", async () => {
  for (const extra of [{ output: {} }, { error: { message: "private upstream diagnostic" } }]) {
    let settled = 0;
    const dispatch = createHandler({ isConfigured: () => true,
      reserve: async () => ({ ok: true, reservation: { id: "test" } }),
      settle: async (_ticket, usage) => { settled++; assert.equal(usage.total_tokens, 28); },
      release: async () => assert.fail("Presentation failure cannot erase known actual usage"),
      markUnknown: async () => assert.fail("Actual usage has already been recorded") });
    global.fetch = async () => new Response(JSON.stringify(terminal(extra)), { headers: { "content-type": "application/json" } });
    const res = sink();
    await dispatch(request("v1/responses"), res);
    assert.equal(settled, 1);
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(res.body, /private upstream diagnostic|response.completed/);
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

test("a definite provider denial releases the token hold and never settles usage", async () => {
  const calls = [];
  const dispatch = createHandler({ isConfigured: () => true,
    reserve: async () => ({ ok: true, reservation: { id: "test" } }),
    settle: async () => assert.fail(), release: async () => { calls.push("release"); } });
  global.fetch = async () => new Response('{"error":"forbidden"}', { status: 403 });
  const res = sink();
  await dispatch(request("v1/responses"), res);
  assert.deepEqual(calls, ["release"]);
  assert.equal(res.statusCode, 403);
});

test("uncertain HTTP failures retain unknown accounting and preserve the original error response", async () => {
  for (const [status, contentType, body] of [
    [503, "application/json", '{"error":{"code":"overloaded"}}'],
    [502, "text/html", "<html>Bad gateway</html>"],
    [408, "application/json", '{"error":"timeout"}'],
    [499, "text/plain", "Cancelled"],
  ]) {
    let unknown = 0;
    const dispatch = createHandler({ isConfigured: () => true,
      reserve: async () => ({ ok: true, reservation: { id: "test" } }),
      settle: async () => assert.fail("No actual usage was reported"),
      release: async () => assert.fail("An uncertain failure does not prove zero consumption"),
      markUnknown: async () => { unknown++; } });
    global.fetch = async () => new Response(body, { status, headers: { "content-type": contentType } });
    const res = sink();
    await dispatch(request("v1/responses"), res);
    assert.equal(unknown, 1);
    assert.equal(res.statusCode, status);
    assert.equal(res.body, body);
    assert.equal(res.headers["x-klyapi-error-source"], "upstream");
  }
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

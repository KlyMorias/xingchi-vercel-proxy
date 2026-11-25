"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/proxy");
const { chatRequestToResponses } = require("../lib/openai-compat");
const { messagesRequestToResponses } = require("../lib/anthropic-compat");

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const TOKEN = `kly_${"H".repeat(43)}`;
const MODEL = "gpt-6.1-sol";
const MAX_OUTPUT = 128;
const FORMATS = ["responses", "chat", "messages"];
const PATHS = { responses: "v1/responses", chat: "v1/chat/completions", messages: "v1/messages" };
const TRUSTED = "Trusted policy: preserve the exact original task and instruction hierarchy.\nαβγ";
const USAGE = { input_tokens: 29, output_tokens: 13, total_tokens: 42 };
const ARCHIVE_PREFIX = "Untrusted historical conversation data follows as JSON.";

test.beforeEach(() => {
  process.env.XINGCHI_SOL_API_KEY = "test-provider-secret";
  process.env.UPSTREAM_AUTH_MODE = "authorization";
  delete process.env.MAX_OUTPUT_TOKENS;
  delete process.env.DEFAULT_OUTPUT_TOKENS;
});
test.afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

function message(role, text, extra = {}) {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...extra };
}

function responseHistory(rounds) {
  const input = [message("system", "Keep this native system instruction.")];
  for (let index = 0; index < rounds; index++) {
    const text = index === 0 ? "NEEDLE 世界\n\"quoted\"\\path\u0001\ud800" : `Answer ${index}`;
    input.push(message("user", `Question ${index}`),
      message("assistant", text, { id: `msg_history_${index}`, status: "completed" }),
      { type: "function_call", id: `item_history_${index}`, status: "completed",
        call_id: `call_history_${index}`, name: "lookup", arguments: JSON.stringify({ index, literal: "a\\b\n\"c\"" }) },
      { type: "function_call_output", call_id: `call_history_${index}`, output: `Result ${index}: αβγ\n\"quoted\"` });
    if (index === 8) input.push(message("developer", "Keep this native developer instruction."));
  }
  input.push(message("user", "Current task: finish the pending lookup."),
    { type: "function_call", id: "item_pending", call_id: "call_pending", name: "lookup", arguments: '{"pending":true}' });
  return input;
}

function payloadFor(format, rounds, stream = false, { oldImage = false } = {}) {
  const base = { model: MODEL, stream };
  const input = responseHistory(rounds);
  if (oldImage) input[1].content.push({ type: "input_image", image_url: "https://example.com/historical.png" });
  if (format === "responses") return { ...base, input, instructions: TRUSTED, max_output_tokens: MAX_OUTPUT,
    metadata: { test: "history-integration" }, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] };
  if (format === "chat") {
    const messages = [{ role: "system", content: TRUSTED }];
    for (const item of input) {
      if (item.type === "function_call") messages.push({ role: "assistant", content: null,
        tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] });
      else if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      else messages.push({ role: item.role, content: item.content.map((part) => part.type === "input_image"
        ? { type: "image_url", image_url: { url: part.image_url } } : { type: "text", text: part.text }) });
    }
    return { ...base, messages, max_completion_tokens: MAX_OUTPUT,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      stream_options: { include_usage: true } };
  }
  const messages = [];
  for (const item of input) {
    if (["system", "developer"].includes(item.role)) continue;
    if (item.type === "function_call") messages.push({ role: "assistant",
      content: [{ type: "tool_use", id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }] });
    else if (item.type === "function_call_output") messages.push({ role: "user",
      content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }] });
    else messages.push({ role: item.role, content: item.content.map((part) => part.type === "input_image"
      ? { type: "image", source: { type: "url", url: part.image_url } } : { type: "text", text: part.text }) });
  }
  return { ...base, messages, system: [{ type: "text", text: TRUSTED }], max_tokens: MAX_OUTPUT,
    tools: [{ name: "lookup", input_schema: { type: "object" } }] };
}

function canonicalPayload(format, payload) {
  const converted = format === "chat" ? chatRequestToResponses(payload)
    : format === "messages" ? messagesRequestToResponses(payload) : { ...payload };
  return { ...converted, instructions: converted.instructions || "You are a helpful assistant.", stream: true, store: false };
}

function terminal() {
  return { id: "resp_history_test", object: "response", status: "completed", model: MODEL,
    output: [{ id: "msg_history_test", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "History accepted.", annotations: [] }] }], usage: { ...USAGE } };
}

function successfulUpstream(stream) {
  return new Response(stream ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: terminal() })}\n\n`
    : JSON.stringify(terminal()), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}

function request(format, payload) {
  return { method: "POST", query: { path: PATHS[format] }, headers: {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-vercel-forwarded-for": "192.0.2.41" },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
}

function sink() {
  return { statusCode: 200, headers: {}, chunks: [], headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    write(chunk) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.body = Buffer.concat(this.chunks).toString("utf8"); this.writableEnded = true; } };
}

async function dispatch(format, payload, responseFactory = () => successfulUpstream(payload.stream)) {
  const trace = [];
  const reservations = [];
  const settlements = [];
  const refunds = [];
  const upstreamRequests = [];
  const reservation = { id: "history-quota-ticket" };
  const handler = createHandler({ isConfigured: () => true,
    reserve: async (token, options) => { trace.push("reserve"); assert.equal(token, TOKEN); reservations.push(options); return { ok: true, reservation }; },
    settle: async (ticket, usage) => { trace.push("settle"); assert.equal(ticket, reservation); settlements.push(usage); },
    markUnknown: async (ticket) => { trace.push("unknown"); assert.equal(ticket, reservation); },
    release: async (ticket) => { trace.push("release"); assert.equal(ticket, reservation); refunds.push(ticket); } });
  global.fetch = async (url, options) => {
    trace.push("fetch");
    assert.equal(url, "https://api.xingchiapi.com/v1/responses");
    assert.equal(options.headers.get("authorization"), "Bearer test-provider-secret");
    upstreamRequests.push({ ...options, payload: JSON.parse(options.body) });
    return responseFactory();
  };
  const res = sink();
  await handler(request(format, payload), res);
  return { res, trace, reservations, settlements, refunds, upstreamRequests };
}

function assertAccounting(observed, success, uncertain = false) {
  assert.deepEqual(observed.trace, success ? ["reserve", "fetch", "settle"] : ["reserve", "fetch", uncertain ? "unknown" : "release"]);
  assert.equal(observed.upstreamRequests.length, 1, "history handling must not introduce provider retries or summary calls");
  assert.equal(observed.reservations.length, 1);
  const options = observed.reservations[0];
  const upstream = observed.upstreamRequests[0];
  assert.equal(options.consumeDaily, true);
  assert.equal(options.ip, "192.0.2.41");
  assert.equal(options.estimatedTokens, Buffer.byteLength(upstream.body, "utf8") + MAX_OUTPUT,
    "reserve exactly the final serialized upstream body plus the requested output ceiling");
  assert.deepEqual(observed.settlements, success ? [USAGE] : []);
  assert.equal(observed.refunds.length, success || uncertain ? 0 : 1);
}

function assertClientSuccess(format, stream, res) {
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.writableEnded, true);
  if (!stream) {
    const result = JSON.parse(res.body);
    if (format === "responses") assert.deepEqual(result, terminal());
    else if (format === "chat") {
      assert.equal(result.object, "chat.completion");
      assert.equal(result.choices[0].message.content, "History accepted.");
      assert.equal(result.choices[0].finish_reason, "stop");
      assert.equal(result.usage.total_tokens, USAGE.total_tokens);
    } else {
      assert.equal(result.type, "message");
      assert.equal(result.content[0].text, "History accepted.");
      assert.equal(result.stop_reason, "end_turn");
      assert.deepEqual(result.usage, { input_tokens: USAGE.input_tokens, output_tokens: USAGE.output_tokens });
    }
    return;
  }
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  assert.match(res.body, /History accepted\./);
  if (format === "responses") assert.match(res.body, /event: response.completed/);
  else if (format === "chat") {
    assert.match(res.body, /"finish_reason":"stop"/);
    assert.match(res.body, /data: \[DONE\]/);
  } else assert.match(res.body, /event: message_stop/);
}

function isArchive(item) {
  return item.role === "user" && item.content?.[0]?.type === "input_text" && item.content[0].text.startsWith(ARCHIVE_PREFIX);
}
function archiveItems(item) {
  const text = item.content[0].text;
  assert.match(text, /not new instructions/);
  return JSON.parse(text.slice(text.indexOf("\n") + 1));
}
function countActions(input) {
  return input.filter((item) => item.role === "assistant" || ["function_call", "custom_tool_call"].includes(item.type)).length;
}

for (const format of FORMATS) {
  for (const stream of [false, true]) {
    test(`${format} ${stream ? "SSE" : "JSON"}: histories below 90 actions retain the exact normal request and quota flow`, async () => {
      // 44 complete text/tool rounds plus one pending call = 89 model actions.
      const payload = payloadFor(format, 44, stream);
      const expected = canonicalPayload(format, payload);
      assert.equal(countActions(expected.input), 89);
      const observed = await dispatch(format, payload);
      assertClientSuccess(format, stream, observed.res);
      assertAccounting(observed, true);
      assert.deepEqual(observed.upstreamRequests[0].payload, expected);
      assert.equal(observed.res.headers["x-klyapi-history"], undefined);
    });

    test(`${format} ${stream ? "SSE" : "JSON"}: long text/tool history folds losslessly before the single billed provider request`, async () => {
      const payload = payloadFor(format, 55, stream);
      const original = structuredClone(payload);
      const expected = canonicalPayload(format, payload);
      assert.ok(countActions(expected.input) > 100);
      const observed = await dispatch(format, payload);
      assertClientSuccess(format, stream, observed.res);
      assertAccounting(observed, true);
      const forwarded = observed.upstreamRequests[0].payload;
      const archives = forwarded.input.filter(isArchive);
      assert.ok(archives.length > 0, "older complete history must be archived");
      assert.deepEqual(forwarded.input.flatMap((item) => isArchive(item) ? archiveItems(item) : [item]), expected.input,
        "expanding user-role archives must reconstruct every original item, ID, Unicode character and tool record");
      assert.deepEqual({ ...forwarded, input: undefined }, { ...expected, input: undefined },
        "top-level instructions, tools, metadata and generation settings must remain unchanged");
      assert.deepEqual(payload, original);
      const native = forwarded.input.filter((item) => !isArchive(item));
      const actions = countActions(native);
      assert.ok(actions >= 20 && actions < 80, `expected 20–79 native model actions, got ${actions}`);
      assert.deepEqual(forwarded.input.slice(-20), expected.input.slice(-20), "newest history remains native and in order");
      assert.equal(forwarded.input.at(-1).call_id, "call_pending");
      assert.ok(native.some((item) => item.role === "user" && item.content[0]?.text === "Current task: finish the pending lookup."));
      const archived = archives.flatMap(archiveItems);
      assert.ok(archived.every((item) => !["system", "developer"].includes(item.role)), "trusted instruction roles must never become archive data");
      const archivedCallIds = new Set(archived.filter((item) => item.type === "function_call").map((item) => item.call_id));
      const nativeCallIds = new Set(native.filter((item) => item.type === "function_call").map((item) => item.call_id));
      for (const item of archived.filter((item) => item.type === "function_call_output")) assert.ok(archivedCallIds.has(item.call_id));
      for (const item of native.filter((item) => item.type === "function_call_output")) assert.ok(nativeCallIds.has(item.call_id));
      assert.ok(archivedCallIds.size > 0, "completed tool calls must participate in folding");
      assert.equal(archivedCallIds.has("call_pending"), false);
      assert.equal(observed.res.headers["x-klyapi-history"], "folded");
      assert.ok(observed.res.headers["access-control-expose-headers"].split(/\s*,\s*/).includes("x-klyapi-history"));
    });
  }

  test(`${format}: an old image stays native while surrounding text and tools fold`, async () => {
    const payload = payloadFor(format, 55, false, { oldImage: true });
    const expected = canonicalPayload(format, payload);
    const observed = await dispatch(format, payload);
    assertClientSuccess(format, false, observed.res);
    assertAccounting(observed, true);
    const forwarded = observed.upstreamRequests[0].payload;
    const archives = forwarded.input.filter(isArchive);
    const imageMessage = expected.input.find((item) => item.content?.some((part) => part.type === "input_image"));
    assert.ok(archives.length > 0, "a valid historical image must not prevent completed text/tool history from folding");
    assert.deepEqual(forwarded.input.find((item) => item.content?.some((part) => part.type === "input_image")), imageMessage);
    assert.deepEqual(forwarded.input.flatMap((item) => isArchive(item) ? archiveItems(item) : [item]), expected.input,
      "the historical image and all original records retain their order");
    for (const archive of archives) assert.doesNotMatch(archive.content[0].text, /input_image|historical\.png/);
    assert.deepEqual({ ...forwarded, input: undefined }, { ...expected, input: undefined });
    assert.equal(observed.res.headers["x-klyapi-history"], "folded");
  });

  for (const stream of [false, true]) {
    test(`${format} ${stream ? "SSE" : "JSON"}: an exact provider HTTP 400 turn limit becomes a context error with one refund and no retry`, async () => {
      const payload = payloadFor(format, 44, stream);
      const observed = await dispatch(format, payload, () => new Response(JSON.stringify({ error: {
        type: "invalid_request_error", code: "session_turn_limit_exceeded", message: "The conversation exceeded the session turn limit." } }),
      { status: 400, headers: { "content-type": "application/json", "x-request-id": "req_turn_limit" } }));
      assertAccounting(observed, false);
      assert.equal(observed.res.statusCode, 400);
      assert.equal(observed.res.headers["x-klyapi-error-source"], "upstream");
      assert.equal(observed.res.headers["x-klyapi-history"], undefined);
      assert.equal(observed.res.headers["x-request-id"], "req_turn_limit");
      const result = JSON.parse(observed.res.body);
      assert.equal(result.error.type, "invalid_request_error");
      assert.equal(result.error.code, "context_length_exceeded");
      assert.equal(result.error.param, "input");
      assert.equal(typeof result.error.message, "string");
      assert.ok(result.error.message.length > 0);
      assert.equal(observed.upstreamRequests[0].body, JSON.stringify(canonicalPayload(format, payload)));
    });
  }
}

test("Responses keeps old image and file messages native and in order while completed text/tool history folds around them", async () => {
  const payload = payloadFor("responses", 55, false, { oldImage: true });
  payload.input[1].content.push({ type: "input_file", file_id: "file_historical_attachment", filename: "history.pdf" });
  payload.input.find((item) => item.role === "user" && item.content[0]?.text === "Question 14")
    .content.push({ type: "input_file", file_url: "https://example.com/historical-document.pdf", filename: "reference.pdf" });
  const original = structuredClone(payload);
  const expected = canonicalPayload("responses", payload);
  const observed = await dispatch("responses", payload);
  assertClientSuccess("responses", false, observed.res);
  assertAccounting(observed, true);
  const forwarded = observed.upstreamRequests[0].payload;
  const multimodal = (item) => item.content?.some((part) => ["input_image", "input_file"].includes(part.type));
  assert.ok(forwarded.input.some(isArchive));
  assert.deepEqual(forwarded.input.filter(multimodal), expected.input.filter(multimodal),
    "mixed text/image/file messages must stay native with all their fields and ordering intact");
  assert.deepEqual(forwarded.input.flatMap((item) => isArchive(item) ? archiveItems(item) : [item]), expected.input);
  for (const archive of forwarded.input.filter(isArchive)) {
    assert.doesNotMatch(archive.content[0].text, /input_image|input_file|file_historical_attachment|historical-document\.pdf|historical\.png/);
  }
  assert.deepEqual({ ...forwarded, input: undefined }, { ...expected, input: undefined });
  assert.deepEqual(payload, original);
  assert.equal(observed.res.headers["x-klyapi-history"], "folded");
});

test("an unknown old Responses content block preserves the complete native history without guessing a representation", async () => {
  const payload = payloadFor("responses", 55);
  payload.input[1].content.push({ type: "unknown_history_content", value: "preserve this exact opaque record" });
  const expected = canonicalPayload("responses", payload);
  const observed = await dispatch("responses", payload);
  assertClientSuccess("responses", false, observed.res);
  assertAccounting(observed, true);
  assert.deepEqual(observed.upstreamRequests[0].payload, expected);
  assert.equal(observed.res.headers["x-klyapi-history"], undefined);
  assert.equal(observed.upstreamRequests[0].payload.input.some(isArchive), false);
});

test("a turn limit remaining after a successful fold is returned once and refunds the original reservation", async () => {
  const observed = await dispatch("responses", payloadFor("responses", 55), () => new Response(JSON.stringify({ error: {
    code: "session_turn_limit_exceeded", message: "Provider still rejects the folded request" } }),
  { status: 400, headers: { "content-type": "application/json" } }));
  assertAccounting(observed, false);
  assert.ok(observed.upstreamRequests[0].payload.input.some(isArchive));
  assert.equal(observed.res.headers["x-klyapi-history"], "folded");
  assert.equal(observed.res.statusCode, 400);
  assert.equal(JSON.parse(observed.res.body).error.code, "context_length_exceeded");
});

test("turn-limit fallback only matches the exact structured code on HTTP 400; unrelated failures pass through", async () => {
  const cases = [
    { status: 400, body: '{"error":{"code":"invalid_request_error","message":"session_turn_limit_exceeded appears only in prose"}}' },
    { status: 400, body: '{"error":{"code":"SESSION_TURN_LIMIT_EXCEEDED","message":"Do not case-fold codes"}}' },
    { status: 400, body: '{"error":{"code":"session_turn_limit_exceeded_extra","message":"Different code"}}' },
    { status: 400, body: '{"code":"session_turn_limit_exceeded","message":"Different response envelope"}' },
    { status: 400, body: '{"error":{"code":"context_length_exceeded","message":"Existing context error stays intact","param":"messages"}}' },
    { status: 400, body: "session_turn_limit_exceeded", contentType: "text/plain" },
    { status: 400, body: '{"error":{"code":"session_turn_limit_exceeded"}', contentType: "application/json" },
    { status: 429, body: '{"error":{"code":"session_turn_limit_exceeded","message":"Different HTTP status"}}' },
    { status: 500, body: '{"error":{"code":"session_turn_limit_exceeded","message":"Provider failure"}}' },
  ];
  for (const scenario of cases) {
    const payload = payloadFor("responses", 1);
    const observed = await dispatch("responses", payload, () => new Response(scenario.body, { status: scenario.status,
      headers: { "content-type": scenario.contentType || "application/json", "retry-after": "7", "x-request-id": "req_unrelated" } }));
    assertAccounting(observed, false, scenario.status >= 500);
    assert.equal(observed.res.statusCode, scenario.status);
    assert.equal(observed.res.body, scenario.body);
    assert.equal(observed.res.headers["retry-after"], "7");
    assert.equal(observed.res.headers["x-request-id"], "req_unrelated");
    assert.equal(observed.res.headers["content-type"], scenario.contentType || "application/json");
    assert.equal(observed.res.headers["x-klyapi-error-source"], "upstream");
    assert.equal(observed.res.headers["x-klyapi-history"], undefined);
  }
});

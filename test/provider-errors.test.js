const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProviderError, MAX_ERROR_BODY_BYTES } = require("../lib/provider-errors");

function upstream(body, { status = 400, headers = {}, statusText = "Provider rejection" } = {}) {
  return new Response(body, { status, statusText,
    headers: { "content-type": "application/json; charset=utf-8", "x-request-id": "req_turn_limit", ...headers } });
}

function streamed(chunks, { close = true, fail } = {}) {
  let pulls = 0;
  let cancelled;
  const body = new ReadableStream({
    pull(controller) {
      const index = pulls++;
      if (index < chunks.length) controller.enqueue(chunks[index]);
      else if (fail) controller.error(fail);
      else if (close) controller.close();
      else return new Promise(() => {});
    },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 });
  return { body, get pulls() { return pulls; }, get cancelled() { return cancelled; } };
}

function headersOf(response) { return [...response.headers]; }

test("exact JSON 400 turn-limit code becomes a safe standard context error with actionable guidance", async () => {
  const raw = JSON.stringify({ error: { code: "session_turn_limit_exceeded", type: "provider_private_type",
    param: "provider_private_param", message: "provider secret raw message: max 100 turns" }, secret: "provider metadata" });
  const original = upstream(raw, { headers: { "cache-control": "no-store", "retry-after": "2",
    "content-length": String(Buffer.byteLength(raw)), "content-encoding": "identity", etag: '"old"' } });
  const response = await normalizeProviderError(original);
  assert.notEqual(response, original);
  assert.equal(response.status, 400);
  assert.equal(response.statusText, "Provider rejection");
  assert.equal(response.headers.get("x-request-id"), "req_turn_limit");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "2");
  for (const name of ["content-length", "content-encoding", "etag"]) assert.equal(response.headers.get(name), null);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.deepEqual(Object.keys(payload.error).sort(), ["code", "message", "param", "type"]);
  assert.equal(payload.error.type, "invalid_request_error");
  assert.equal(payload.error.code, "context_length_exceeded");
  assert.equal(payload.error.param, "input");
  assert.match(payload.error.message, /\/compact/);
  assert.match(payload.error.message, /\/new/);
  assert.doesNotMatch(JSON.stringify(payload), /provider secret|private_type|private_param|provider metadata|100 turns/);
  assert.equal(original.body.locked, false);
});

test("JSON error inspection accepts vendor JSON and the inclusive 64 KiB byte boundary", async () => {
  const json = JSON.stringify({ error: { code: "session_turn_limit_exceeded" }, note: "é" });
  const body = Buffer.concat([Buffer.from(json), Buffer.alloc(MAX_ERROR_BODY_BYTES - Buffer.byteLength(json), 32)]);
  const source = streamed([body.subarray(0, 25), body.subarray(25)]);
  const response = await normalizeProviderError(upstream(source.body, { headers: { "content-type": "Application/Problem+JSON; charset=utf-8" } }));
  assert.equal(body.length, MAX_ERROR_BODY_BYTES);
  assert.equal((await response.json()).error.code, "context_length_exceeded");
  assert.equal(source.body.locked, false);
});

test("non-400, non-JSON and empty responses pass through by identity without reading", async () => {
  const targeted = Buffer.from('{"error":{"code":"session_turn_limit_exceeded"}}');
  for (const options of [{ status: 200 }, { status: 401 }, { status: 413 }, { status: 429 }, { status: 500 },
    { headers: { "content-type": "text/plain" } }, { headers: { "content-type": "application/octet-stream" } },
    { headers: { "content-type": "text/event-stream" } }, { headers: { "content-type": "" } }]) {
    const source = streamed([targeted]);
    const original = upstream(source.body, options);
    assert.equal(await normalizeProviderError(original), original);
    assert.equal(source.pulls, 0);
    assert.equal(original.bodyUsed, false);
    await original.body.cancel("test cleanup");
  }
  const original = upstream(null);
  assert.equal(await normalizeProviderError(original), original);
});

test("unrelated codes, message-only matches, malformed JSON and binary JSON bodies retain exact bytes and metadata", async () => {
  const bodies = [
    Buffer.from('{ "error" : { "code": "rate_limit_exceeded", "message": "maximum 100 turns exceeded" } }\r\n'),
    Buffer.from('{"error":{"message":"session_turn_limit_exceeded: maximum 100 turns exceeded"}}'),
    Buffer.from('{"error":{"type":"session_turn_limit_exceeded"}}'),
    Buffer.from('{"code":"session_turn_limit_exceeded","message":"100 turns"}'),
    Buffer.from('{"error":{"code":"SESSION_TURN_LIMIT_EXCEEDED"}}'),
    Buffer.from('{"error":{"code":"session_turn_limit_exceeded_extra"}}'),
    Buffer.from('{"error":{"code":"session_turn_limit_exceeded"} trailing private text'),
    Buffer.from([0xff, 0x00, 0x7b, 0x7d, 0x80]),
    Buffer.from('{"error":{"code":"session_turn_limit_exceeded"},"bad":"\xff"}', "latin1"),
    Buffer.alloc(0),
  ];
  for (const bytes of bodies) {
    const source = streamed([bytes.subarray(0, 10), bytes.subarray(10)]);
    const original = upstream(source.body, { headers: { "content-length": String(bytes.length), "x-extra": "retain me" } });
    const response = await normalizeProviderError(original);
    assert.equal(response.status, original.status);
    assert.equal(response.statusText, original.statusText);
    assert.deepEqual(headersOf(response), headersOf(original));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(source.body.locked, false);
  }
});

test("an oversized streamed JSON body replays every byte including the crossing chunk and reads no further eagerly", async () => {
  const first = Buffer.alloc(MAX_ERROR_BODY_BYTES - 5, 32);
  const crossing = Buffer.from('{"error":{"code":"session_turn_limit_exceeded"}}');
  const remainder = [Buffer.from("provider large remainder 1"), Buffer.from([0x00, 0xff, 0x80, 0x0a])];
  const source = streamed([first, crossing, ...remainder]);
  const original = upstream(source.body, { headers: { "content-length": String(first.length + crossing.length + 30), "x-extra": "retained" } });
  const response = await normalizeProviderError(original);
  assert.equal(source.pulls, 2, "only read through the first over-limit chunk");
  assert.deepEqual(headersOf(response), headersOf(original));
  assert.equal(response.status, 400);
  assert.equal(response.statusText, original.statusText);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.pulls, 2, "constructing a replay must not drain the provider");
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, first);
  assert.equal(source.pulls, 2);
  assert.deepEqual((await reader.read()).value, crossing);
  assert.equal(source.pulls, 2, "buffered prefix applies downstream backpressure");
  const output = [first, crossing];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output.push(value);
  }
  assert.deepEqual(Buffer.concat(output), Buffer.concat([first, crossing, ...remainder]));
  assert.equal(source.body.locked, false);
  reader.releaseLock();
});

test("a single huge crossing chunk remains unparsed and is preserved without consuming an open remainder", async () => {
  const bytes = Buffer.concat([Buffer.from('{"error":{"code":"session_turn_limit_exceeded"}}'), Buffer.alloc(MAX_ERROR_BODY_BYTES * 4, 32)]);
  const source = streamed([bytes], { close: false });
  const response = await normalizeProviderError(upstream(source.body));
  assert.equal(source.pulls, 1);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  assert.equal(source.pulls, 1);
  await reader.cancel("downstream done");
  assert.equal(source.cancelled, "downstream done");
  assert.equal(source.body.locked, false);
});

test("cancelling an oversized replay cancels its provider reader before reading any remainder", async () => {
  const source = streamed([Buffer.alloc(MAX_ERROR_BODY_BYTES), Buffer.from("crossing"), Buffer.from("must remain unread")]);
  const response = await normalizeProviderError(upstream(source.body));
  assert.equal(source.pulls, 2);
  const reason = new Error("client disconnected");
  await response.body.cancel(reason);
  assert.equal(source.cancelled, reason);
  assert.equal(source.pulls, 2);
  assert.equal(source.body.locked, false);
});

test("inspection preserves a consumed prefix and original provider stream error", async () => {
  const prefix = Buffer.from('{"error":');
  const failure = new Error("provider stream failed");
  const source = streamed([prefix], { fail: failure });
  const response = await normalizeProviderError(upstream(source.body));
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, prefix);
  await assert.rejects(reader.read(), (error) => error === failure);
  assert.equal(source.body.locked, false);
  reader.releaseLock();
});

test("cancelling a replay while its remainder read is pending forwards cancellation and releases the provider lock", async () => {
  const source = streamed([Buffer.alloc(MAX_ERROR_BODY_BYTES + 1)], { close: false });
  const response = await normalizeProviderError(upstream(source.body));
  const reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.pulls, 2);
  await reader.cancel("aborted pending read");
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(source.cancelled, "aborted pending read");
  assert.equal(source.body.locked, false);
  reader.releaseLock();
});

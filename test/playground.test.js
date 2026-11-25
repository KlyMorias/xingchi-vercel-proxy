const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateInput, safeMessage, createSseParser, createResponseAccumulator, consumeResponse } = require("../assets/playground");
const playgroundSource = fs.readFileSync(path.join(__dirname, "../assets/playground.js"), "utf8");

const key = "kly_" + "a".repeat(42) + "_";
const valid = { key, model: "gpt-6.1-sol", prompt: "Merhaba", maxOutputTokens: 512 };
function final(text = "Merhaba 🌍", extra = {}) {
  return { id: "resp_playground", object: "response", status: "completed", output: [
    { id: "msg_one", type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ], usage: { input_tokens: 17, output_tokens: 11, total_tokens: 28 }, ...extra };
}
const frame = (value, separator = "\n") => `event: ${value.type}${separator}data: ${JSON.stringify(value)}${separator}${separator}`;
function source(values, { open = false, stalledCancel = false, chunks } = {}) {
  let cancelled = 0;
  const bytes = chunks || values.map((event) => Buffer.from(frame(event)));
  const body = new ReadableStream({ start(controller) {
    for (const chunk of bytes) controller.enqueue(chunk);
    if (!open) controller.close();
  }, cancel() { cancelled++; return stalledCancel ? new Promise(() => {}) : undefined; } });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), body, cancelled: () => cancelled };
}
async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Playground waited for EOF after a terminal event")), 500);
  })]); } finally { clearTimeout(timer); }
}

function playgroundFixture(fetchResponse = async () => { throw new Error("Unexpected generation"); }) {
  let document;
  class Element {
    constructor(tagName = "DIV") {
      this.tagName = tagName;
      this.value = "";
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
      this.type = "password";
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.classList = { toggle() {} };
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) {
      // Deliberately invoke even disabled controls to exercise the busy guard.
      return Promise.all([...(this.listeners.get(type) || [])].map((listener) => listener({ preventDefault() {}, target: this })));
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    replaceChildren() { this.children = []; }
    append(child) { this.children.push(child); }
    focus() { document.activeElement = this; }
    querySelectorAll(selector) {
      assert.equal(selector, "button[data-playground-prompt]");
      return Object.values(starters);
    }
  }
  const suffixes = ["form", "key", "key-note", "model", "model-note", "prompt", "limit", "send", "stop", "output", "empty", "status", "elapsed", "first-token", "input-tokens", "tokens", "total-tokens", "usage-source", "error", "copy", "clear", "key-toggle"];
  const ui = Object.fromEntries(suffixes.map((name) => [name, new Element()]));
  const starters = Object.fromEntries(["idea", "code", "edit"].map((name) => {
    const button = new Element("BUTTON");
    button.type = "button";
    button.dataset.playgroundPrompt = name;
    return [name, button];
  }));
  document = { activeElement: null, getElementById(id) { return ui[id.replace(/^playground-/, "")] || null; }, createElement(tag) { return new Element(tag.toUpperCase()); } };
  const window = new Element();
  const requests = [];
  const module = { exports: {} };
  const frames = new Map();
  let nextFrame = 0;
  vm.runInNewContext(playgroundSource, { module, window, document, TextDecoder, AbortController, performance: { now: () => 1000 },
    fetch: (...args) => { requests.push(args); return fetchResponse(...args); },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: "assets/playground.js" });
  ui.key.value = key;
  ui.model.value = valid.model;
  ui.prompt.value = valid.prompt;
  ui.limit.value = String(valid.maxOutputTokens);
  const instance = module.exports.init({ getModels: () => [{ id: valid.model }] });
  return { ui, starters, document, requests, instance };
}

test("prompt starters fill useful Turkish drafts, focus the prompt and never generate on click", async (t) => {
  const fixture = playgroundFixture();
  t.after(() => fixture.instance.dispose());
  const expected = {
    idea: "Yeni bir uygulama fikrini; hedef kullanıcı, temel özellikler ve ilk sürüm adımlarıyla geliştir.",
    code: "JavaScript ile bir API isteği gönderen, hata yönetimi içeren kısa bir örnek yaz.",
    edit: "Aşağıdaki metni daha açık ve akıcı hale getir:\n\n",
  };
  for (const [name, text] of Object.entries(expected)) {
    await fixture.starters[name].emit("click");
    assert.equal(fixture.ui.prompt.value, text);
    assert.equal(fixture.document.activeElement, fixture.ui.prompt);
    assert.equal(fixture.ui.status.dataset.state, "idle");
    assert.equal(fixture.requests.length, 0);
  }
});

test("prompt starters ignore connecting and streaming clicks and work again after a terminal response", async (t) => {
  let resolveFetch;
  const pendingResponse = new Promise((resolve) => { resolveFetch = resolve; });
  let stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const fixture = playgroundFixture(() => pendingResponse);
  t.after(() => fixture.instance.dispose());
  const submission = fixture.ui.form.emit("submit");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.ui.status.dataset.state, "loading");
  for (const name of ['input-tokens', 'tokens', 'total-tokens']) assert.equal(fixture.ui[name].textContent, '—');
  assert.equal(fixture.ui['usage-source'].dataset.state, 'pending');
  assert.equal(JSON.parse(fixture.requests[0][1].body).input, valid.prompt);
  async function assertIgnored() {
    for (const starter of Object.values(fixture.starters)) {
      assert.equal(starter.disabled, true);
      await starter.emit("click");
      assert.equal(fixture.ui.prompt.value, valid.prompt);
      assert.equal(fixture.document.activeElement, null);
    }
  }
  await assertIgnored();
  resolveFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  stream.enqueue(Buffer.from(frame({ type: "response.output_text.delta", delta: "Merhaba" })));
  await new Promise(setImmediate);
  assert.equal(fixture.ui.status.dataset.state, "streaming");
  for (const name of ['input-tokens', 'tokens', 'total-tokens']) assert.equal(fixture.ui[name].textContent, '—', 'SSE text chunks are not token counts');
  await assertIgnored();
  stream.enqueue(Buffer.from(frame({ type: "response.completed", response: final() })));
  await promptly(submission);
  assert.equal(fixture.ui.status.dataset.state, "complete");
  assert.equal(fixture.ui['input-tokens'].textContent, '17');
  assert.equal(fixture.ui.tokens.textContent, '11');
  assert.equal(fixture.ui['total-tokens'].textContent, '28');
  assert.equal(fixture.ui['usage-source'].dataset.state, 'reported');
  for (const starter of Object.values(fixture.starters)) assert.equal(starter.disabled, false);
  await fixture.starters.code.emit("click");
  assert.equal(fixture.ui.prompt.value, "JavaScript ile bir API isteği gönderen, hata yönetimi içeren kısa bir örnek yaz.");
  assert.equal(fixture.document.activeElement, fixture.ui.prompt);
  assert.equal(fixture.requests.length, 1);
});

test("prompt starters recover after a failed request and dispose removes their listeners", async (t) => {
  const fixture = playgroundFixture(async () => { throw new Error("Offline"); });
  t.after(() => fixture.instance.dispose());
  await fixture.ui.form.emit("submit");
  assert.equal(fixture.ui.status.dataset.state, "error");
  for (const starter of Object.values(fixture.starters)) assert.equal(starter.disabled, false);
  await fixture.starters.edit.emit("click");
  assert.equal(fixture.ui.prompt.value, "Aşağıdaki metni daha açık ve akıcı hale getir:\n\n");
  assert.equal(fixture.requests.length, 1);
  fixture.instance.dispose();
  fixture.ui.prompt.value = "Korunan taslak";
  await fixture.starters.idea.emit("click");
  assert.equal(fixture.ui.prompt.value, "Korunan taslak");
  assert.equal(fixture.ui.key.value, "");
});

test("playground only submits a catalog model, bounded prompt and personal key without putting credentials in payload", () => {
  assert.deepEqual(validateInput(valid), { model: valid.model, input: "Merhaba", max_output_tokens: 512, stream: true, store: false });
  assert.equal(JSON.stringify(validateInput(valid)).includes(key), false);
  assert.equal(validateInput({ ...valid, model: "gpt-6-astra" }).model, "gpt-6-astra");
  assert.throws(() => validateInput({ ...valid, model: "gpt-6-astra" }, ["gpt-6.1-sol"]), { code: "invalid_model" });
  for (const bad of [undefined, "", "sk-provider-secret", "kly_short", key + "\n"]) {
    assert.throws(() => validateInput({ ...valid, key: bad }), { code: "invalid_key" });
  }
  assert.throws(() => validateInput({ ...valid, model: 'gpt-6.1-sol"\nmalicious=true' }), { code: "invalid_model" });
});

test("playground rejects blank/oversized prompts, fractional or excessive limits before fetch", () => {
  for (const prompt of [undefined, null, "", "  ", "a".repeat(8001)]) {
    assert.throws(() => validateInput({ ...valid, prompt }), { code: "invalid_prompt" });
  }
  for (const maxOutputTokens of ["512", NaN, undefined, 0, 63, 512.5, 4097]) {
    assert.throws(() => validateInput({ ...valid, maxOutputTokens }), { code: "invalid_limit" });
  }
  assert.equal(validateInput({ ...valid, prompt: "a".repeat(8000), maxOutputTokens: 4096 }).max_output_tokens, 4096);
});

test("safe API error messages redact personal/provider credentials including base64url endings", () => {
  const provider = "sk-" + "b".repeat(62) + "_-";
  const value = safeMessage(`Rejected ${key} and ${provider}.`);
  assert.equal(value.includes(key), false);
  assert.equal(value.includes(provider), false);
  assert.equal(value.match(/\[anahtar gizlendi\]/g).length, 2);
  assert.ok(safeMessage("x".repeat(1000)).length <= 800);
});

test("SSE parser preserves byte-split Unicode and CRLF pairs while ignoring keepalives and DONE", () => {
  const values = [];
  const parser = createSseParser((event) => values.push(event));
  const event = { type: "response.output_text.delta", delta: "İstanbul 🌍 東京" };
  const bytes = Buffer.from(": keepalive\r\n\r\n" + frame(event, "\r\n") + "data: [DONE]\r\n\r\n");
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.end();
  assert.deepEqual(values, [event]);
});

test("SSE named events and multiline data are supported, including an undelimited final block", () => {
  const values = [];
  const parser = createSseParser((event) => values.push(event));
  parser.push('event: response.output_text.delta\rdata: {\rdata: "delta":"OK"}\r\r');
  parser.push('data: {"type":"response.created","response":{}}');
  parser.end();
  assert.deepEqual(values, [{ delta: "OK", type: "response.output_text.delta" }, { type: "response.created", response: {} }]);
});

test("malformed JSON, non-object events, invalid UTF-8 and oversized event buffers fail explicitly", () => {
  for (const value of ["data: invalid\n\n", "data: null\n\n", "data: []\n\n"]) {
    assert.throws(() => createSseParser(() => {}).push(value), { code: "invalid_event" });
  }
  const parser = createSseParser(() => {});
  assert.throws(() => parser.push(Uint8Array.of(0xff)), { code: "invalid_event" });
  const cut = createSseParser(() => {});
  cut.push(Uint8Array.of(0xf0, 0x9f));
  assert.throws(() => cut.end(), { code: "invalid_event" });
  assert.throws(() => createSseParser(() => {}).push("a".repeat(2_000_001)), { code: "response_too_large" });
});

test("terminal final text is authoritative and done snapshots never duplicate visible deltas", () => {
  const accumulator = createResponseAccumulator();
  accumulator.accept({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Mer" });
  assert.equal(accumulator.accept({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "haba 🌍" }).text, "Merhaba 🌍");
  assert.equal(accumulator.accept({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Merhaba 🌍" }).text, "Merhaba 🌍");
  const result = accumulator.accept({ type: "response.completed", response: final() });
  assert.equal(result.text, "Merhaba 🌍");
  assert.equal(result.outputTokens, 11);
  assert.equal(result.inputTokens, 17);
  assert.equal(result.totalTokens, 28);
  assert.equal(result.usageStatus, 'reported');
  assert.equal(result.terminal, true);
  assert.equal(accumulator.accept({ type: "response.output_text.delta", delta: "duplicate" }).text, "Merhaba 🌍");
  assert.equal(accumulator.finish().status, "completed");
});

test("out-of-order parts display in output order and final refusal text is retained", () => {
  const a = createResponseAccumulator();
  a.accept({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "second" });
  assert.equal(a.accept({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "first " }).text, "first second");
  const response = final("", { output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot help." }] }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  const result = a.accept({ type: "response.completed", response });
  assert.equal(result.text, "Cannot help.");
  assert.equal(result.outputTokens, 0);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.totalTokens, 0);
});

test("incomplete responses retain partial output and real usage without pretending to complete", () => {
  const a = createResponseAccumulator();
  const result = a.accept({ type: "response.incomplete", response: final("partial", {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: null,
  }) });
  assert.equal(result.status, "incomplete");
  assert.equal(result.text, "partial");
  assert.equal(result.incompleteReason, "max_output_tokens");
  assert.equal(result.outputTokens, null);
  assert.equal(result.inputTokens, null);
  assert.equal(result.totalTokens, null);
  assert.equal(result.usageStatus, 'unavailable');
  assert.throws(() => createResponseAccumulator().finish(), { code: "incomplete_stream" });
});

test('usage metrics require all consistent provider totals without type coercion', () => {
  const validUsage = { input_tokens: 17, output_tokens: 11, total_tokens: 28 };
  const assertUnknown = (usage, status = 'invalid') => {
    const result = createResponseAccumulator().accept({ type: 'response.completed', response: final('Measured answer', { usage }) });
    assert.equal(result.text, 'Measured answer');
    assert.equal(result.status, 'completed', 'unavailable accounting does not rewrite the response outcome');
    assert.equal(result.usageStatus, status);
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, null);
    assert.equal(result.totalTokens, null);
  };
  assertUnknown(undefined, 'unavailable');
  assertUnknown(null, 'unavailable');
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
    for (const value of [undefined, null, '', false, true, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
      assertUnknown({ ...validUsage, [field]: value });
    }
  }
  assertUnknown({ ...validUsage, total_tokens: 29 });
  assertUnknown({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER });
  assertUnknown({ output_tokens: 11 });
});

test('all provider usage detail counters are validated as subsets and never added to the total', () => {
  const usage = { input_tokens: 17, output_tokens: 11, total_tokens: 28,
    input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 6 } };
  const measured = createResponseAccumulator().accept({ type: 'response.completed', response: final('', { usage }) });
  assert.equal(measured.inputTokens, 17);
  assert.equal(measured.outputTokens, 11);
  assert.equal(measured.totalTokens, 28);
  for (const [name, ceiling] of [['input_tokens_details', 17], ['output_tokens_details', 11]]) {
    for (const details of [null, [], false, 'details', { count: null }, { count: false }, { count: '1' },
      { count: -1 }, { count: 0.5 }, { count: ceiling + 1 }, { count: {} }]) {
      const result = createResponseAccumulator().accept({ type: 'response.completed', response: final('', { usage: { ...usage, [name]: details } }) });
      assert.equal(result.usageStatus, 'invalid');
      assert.equal(result.inputTokens, null);
      assert.equal(result.outputTokens, null);
      assert.equal(result.totalTokens, null);
    }
  }
});

test('playground displays verified usage, explicit zero and clears the metrics together', async (t) => {
  const fixture = playgroundFixture(async () => source([{ type: 'response.completed', response: final() }]).response);
  t.after(() => fixture.instance.dispose());
  await fixture.ui.form.emit('submit');
  assert.equal(fixture.ui['input-tokens'].textContent, '17');
  assert.equal(fixture.ui.tokens.textContent, '11');
  assert.equal(fixture.ui['total-tokens'].textContent, '28');
  assert.match(fixture.ui['usage-source'].textContent, /Kaynak: sağlayıcı yanıtı/);
  await fixture.ui.clear.emit('click');
  for (const name of ['input-tokens', 'tokens', 'total-tokens']) assert.equal(fixture.ui[name].textContent, '—');
  assert.equal(fixture.ui['usage-source'].dataset.state, 'idle');
  const zero = playgroundFixture(async () => source([{ type: 'response.completed', response: final('', {
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }) }]).response);
  t.after(() => zero.instance.dispose()); await zero.ui.form.emit('submit');
  for (const name of ['input-tokens', 'tokens', 'total-tokens']) assert.equal(zero.ui[name].textContent, '0');
  assert.equal(zero.ui['usage-source'].dataset.state, 'reported');
});

test('playground preserves a completed answer while explicitly suppressing invalid usage', async (t) => {
  const fixture = playgroundFixture(async () => source([{ type: 'response.completed', response: final('Real answer', {
    usage: { input_tokens: 17, output_tokens: 11, total_tokens: 27 } }) }]).response);
  t.after(() => fixture.instance.dispose()); await fixture.ui.form.emit('submit');
  assert.equal(fixture.ui.output.textContent, 'Real answer');
  assert.equal(fixture.ui.status.dataset.state, 'complete');
  assert.equal(fixture.ui['usage-source'].dataset.state, 'invalid');
  for (const name of ['input-tokens', 'tokens', 'total-tokens']) assert.equal(fixture.ui[name].textContent, '—');
});

test('playground model selection is explicit, catalog bounded and sends no request', (t) => {
  const fixture = playgroundFixture(); t.after(() => fixture.instance.dispose());
  fixture.instance.setModels([{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }]);
  assert.equal(fixture.instance.setSelectedModel('gpt-6-astra'), true);
  assert.equal(fixture.ui.model.value, 'gpt-6-astra');
  assert.equal(fixture.instance.setSelectedModel('not-in-catalog'), false);
  assert.equal(fixture.ui.model.value, 'gpt-6-astra');
  assert.equal(fixture.requests.length, 0);
});

test("error and mismatched completion events never become successful output", () => {
  for (const event of [
    { type: "error", error: { message: "Provider unavailable" } },
    { type: "response.failed", response: { error: { message: "No balance" } } },
    { type: "response.cancelled" },
  ]) assert.throws(() => createResponseAccumulator().accept(event), { code: "api_error" });
  assert.throws(() => createResponseAccumulator().accept({ type: "response.completed", response: final("", { status: "incomplete" }) }), { code: "invalid_response" });
});

test("stream consumer stops promptly on completed while provider EOF/cancel never settle", async () => {
  const response = source([
    { type: "response.output_text.delta", delta: "Merhaba 🌍" },
    { type: "response.completed", response: final() },
  ], { open: true, stalledCancel: true });
  const updates = [];
  const result = await promptly(consumeResponse(response.response, { onUpdate: (update) => updates.push(update) }));
  assert.equal(result.text, "Merhaba 🌍");
  assert.equal(updates.at(-1).status, "completed");
  assert.equal(response.cancelled(), 1);
  assert.equal(response.body.locked, false);
});

test("stream consumer ignores invalid trailing data after an authoritative completion", async () => {
  const response = source([], { chunks: [Buffer.from(frame({ type: "response.completed", response: final() }) + "data: invalid trailing junk\n\n")], open: true });
  assert.equal((await promptly(consumeResponse(response.response))).text, "Merhaba 🌍");
});

test("a truncated stream or DONE alone cannot masquerade as success", async () => {
  await assert.rejects(consumeResponse(source([{ type: "response.output_text.delta", delta: "partial" }]).response), { code: "incomplete_stream" });
  await assert.rejects(consumeResponse(source([], { chunks: [Buffer.from("data: [DONE]\n\n")] }).response), { code: "incomplete_stream" });
});

test("JSON terminal responses work, but HTTP200 error JSON and HTTP errors remain errors", async () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.equal((await consumeResponse(json(final()))).outputTokens, 11);
  await assert.rejects(consumeResponse(json({ error: "Key service is temporarily unavailable" })), { code: "api_error" });
  await assert.rejects(consumeResponse(json({ error: { message: `Rejected ${key}` } }, 401)), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(key), false);
    return true;
  });
  await assert.rejects(consumeResponse(new Response("<html>error</html>", { status: 503 })), { code: "api_error" });
  await assert.rejects(consumeResponse(json({ object: "response", status: "in_progress", output: [] })), { code: "invalid_response" });
});

test("HTTP200 in-stream errors are surfaced and empty reasoning events never invent text or tokens", async () => {
  await assert.rejects(consumeResponse(source([{ error: { code: "upstream_http_error", message: "No balance" } }]).response), { code: "api_error" });
  const a = createResponseAccumulator();
  const state = a.accept({ type: "response.reasoning_summary_text.delta", delta: "not visible answer text" });
  assert.equal(state.text, "");
  assert.equal(state.outputTokens, null);
});

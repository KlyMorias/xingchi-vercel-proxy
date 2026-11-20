const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startKeepalive } = require("../lib/client-keepalive");

function response({ headersSent = false, contentType, backpressure = false } = {}) {
  const events = new EventEmitter();
  const chunks = [];
  return { headers: contentType ? { "content-type": contentType } : {}, chunks, statusCode: 201, headersSent,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    write(chunk) { chunks.push(chunk); this.headersSent = true; return !backpressure; },
    end(chunk) { if (chunk) chunks.push(chunk); this.writableEnded = true; events.emit("finish"); },
    once: events.once.bind(events), off: events.off.bind(events), emit: events.emit.bind(events),
  };
}

function waitForTick() { return new Promise((resolve) => setTimeout(resolve, 18)); }

test("delayed JSON response stays valid with whitespace-only keepalive", async () => {
  const res = response();
  const keepalive = startKeepalive(res, { intervalMs: 5 });
  try {
    assert.equal(keepalive.started, false);
    await waitForTick();
    assert.equal(keepalive.started, true);
    assert.ok(res.chunks.length > 0);
    assert.ok(res.chunks.every((chunk) => /^\s+$/.test(chunk)));
    keepalive.stop();
    res.end(JSON.stringify({ output: "real model answer" }));
    assert.deepEqual(JSON.parse(res.chunks.join("")), { output: "real model answer" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.equal(res.headers["cache-control"], "no-cache, no-transform");
    assert.equal(res.headers["x-accel-buffering"], "no");
  } finally { keepalive.stop(); }
});

test("SSE keepalive emits comments without fabricated data or model deltas", async () => {
  const res = response();
  const keepalive = startKeepalive(res, { stream: true, intervalMs: 5 });
  try {
    await waitForTick();
    assert.equal(keepalive.started, true);
    assert.ok(res.chunks.length > 0);
    assert.ok(res.chunks.every((chunk) => chunk === ": keep-alive\n\n"));
    assert.doesNotMatch(res.chunks.join(""), /data:|content|delta|\[DONE\]/);
    assert.match(res.headers["content-type"], /^text\/event-stream/);
  } finally { keepalive.stop(); }
});

test("stop and response completion prevent later writes", async () => {
  const res = response();
  const keepalive = startKeepalive(res, { intervalMs: 5 });
  keepalive.stop();
  await waitForTick();
  assert.equal(res.chunks.length, 0);
  const closing = response();
  const running = startKeepalive(closing, { intervalMs: 5 });
  closing.end("{}");
  await waitForTick();
  assert.deepEqual(closing.chunks, ["{}"]);
  assert.equal(running.started, false);
});

test("an already started matching stream preserves its established headers", async () => {
  const res = response({ headersSent: true, contentType: "text/event-stream; charset=utf-8" });
  res.statusCode = 202;
  res.headers["cache-control"] = "private";
  const keepalive = startKeepalive(res, { stream: true, intervalMs: 5 });
  try {
    await waitForTick();
    assert.ok(res.chunks.length > 0);
    assert.equal(res.statusCode, 202);
    assert.equal(res.headers["cache-control"], "private");
  } finally { keepalive.stop(); }
});

test("mismatching established response mode is left untouched", async () => {
  const res = response({ headersSent: true, contentType: "application/problem+json" });
  const keepalive = startKeepalive(res, { stream: true, intervalMs: 5 });
  await waitForTick();
  assert.equal(keepalive.started, false);
  assert.deepEqual(res.chunks, []);
  assert.equal(res.headers["content-type"], "application/problem+json");
});

test("backpressure pauses heartbeats until drain and close stops them", async () => {
  const res = response({ backpressure: true });
  const keepalive = startKeepalive(res, { intervalMs: 5 });
  try {
    await waitForTick();
    assert.equal(res.chunks.length, 1);
    res.emit("drain");
    await waitForTick();
    assert.equal(res.chunks.length, 2);
    res.emit("close");
    await waitForTick();
    assert.equal(res.chunks.length, 2);
  } finally { keepalive.stop(); }
});

test("a write exception ends the timer without escaping to the caller", async () => {
  const res = response();
  let calls = 0;
  res.write = () => { calls++; throw new Error("socket gone"); };
  const keepalive = startKeepalive(res, { intervalMs: 5 });
  try {
    await waitForTick();
    assert.equal(calls, 1);
    await waitForTick();
    assert.equal(calls, 1);
  } finally { keepalive.stop(); }
});

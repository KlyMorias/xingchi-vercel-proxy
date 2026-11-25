const test = require("node:test");
const assert = require("node:assert/strict");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const { createStateStore } = require("../lib/state-store");

const originalEnv = { ...process.env };
test.beforeEach(() => { process.env.BLOB_STORE_ID = "store_reconciliation_test"; });
test.afterEach(() => { process.env = { ...originalEnv }; });

function initialState(extra = {}) {
  return { version: 1, users: {}, sessions: {}, keys: {},
    usage: { counter: { used: 0 } }, reservations: {}, login_attempts: {}, ...extra };
}

function memoryBlob(state = initialState()) {
  let current = JSON.stringify(state);
  let revision = 1;
  return {
    reads: [], writes: [], onRead: null, onWrite: null,
    async get(_path, options) {
      this.reads.push(options);
      if (this.onRead) {
        const result = await this.onRead(this.reads.length);
        if (result === null) return null;
      }
      return { statusCode: 200,
        blob: { etag: `revision-${revision}`, size: Buffer.byteLength(current) },
        stream: new Response(current).body };
    },
    async put(_path, text, options) {
      this.writes.push({ text, options });
      if (options.ifMatch !== `revision-${revision}`) throw new BlobPreconditionFailedError();
      if (this.onWrite) return this.onWrite(text, options);
      return this.commit(text);
    },
    commit(text) {
      current = text;
      revision++;
      return { etag: `revision-${revision}` };
    },
    state() { return JSON.parse(current); },
  };
}

function storeFor(client, extra = {}) {
  return createStateStore(client, { attempts: 3, pause: async () => {}, warn: () => {}, ...extra });
}

function differentMarker(marker) {
  return marker.slice(0, -1) + (marker.endsWith("0") ? "1" : "0");
}

function lostResponse() { return new TypeError("fetch failed"); }

test("a committed write with a lost response returns the original result after one fresh snapshot", async () => {
  const client = memoryBlob();
  client.onWrite = (text) => { client.commit(text); throw lostResponse(); };
  let callbacks = 0;
  const result = await storeFor(client).mutateState((draft) => {
    callbacks++;
    return ++draft.usage.counter.used;
  });
  assert.equal(result, 1);
  assert.equal(callbacks, 1);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reads.length, 2);
  assert.equal(client.state().usage.counter.used, 1);
  assert.match(client.state().commit_id, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(client.state()), client.writes[0].text);
  assert.equal(client.reads[1].access, "private");
  assert.equal(client.reads[1].useCache, false);
  assert.equal(client.reads[1].headers["accept-encoding"], "identity");
});

test("reconciliation stops after its short verification budget during a read outage", async () => {
  const client = memoryBlob();
  let clock = 0;
  client.onWrite = () => { throw lostResponse(); };
  client.onRead = (attempt) => {
    if (attempt > 1) { clock += 2100; throw lostResponse(); }
  };
  await assert.rejects(storeFor(client, { now: () => clock }).mutateState((draft) => {
    return ++draft.usage.counter.used;
  }), { code: "write_unavailable" });
  assert.equal(client.reads.length, 2);
  assert.equal(client.writes.length, 1);
  assert.equal(client.state().usage.counter.used, 0);
});

test("a write that never committed fails without repeating its callback or write", async () => {
  const client = memoryBlob();
  client.onWrite = () => { throw lostResponse(); };
  let callbacks = 0;
  await assert.rejects(storeFor(client).mutateState((draft) => {
    callbacks++;
    return ++draft.usage.counter.used;
  }), { code: "write_unavailable" });
  assert.equal(callbacks, 1);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reads.length, 2);
  assert.equal(client.state().usage.counter.used, 0);
  assert.equal(client.state().commit_id, undefined);
});

test("identical business data from another writer cannot confirm this transaction", async () => {
  const client = memoryBlob();
  let candidate;
  client.onWrite = (text) => {
    candidate = JSON.parse(text);
    const competitor = structuredClone(candidate);
    competitor.commit_id = differentMarker(candidate.commit_id);
    client.commit(JSON.stringify(competitor));
    throw lostResponse();
  };
  let callbacks = 0;
  await assert.rejects(storeFor(client).mutateState((draft) => {
    callbacks++;
    return ++draft.usage.counter.used;
  }), { code: "write_unavailable" });
  const observed = client.state();
  assert.notEqual(observed.commit_id, candidate.commit_id);
  delete observed.commit_id;
  delete candidate.commit_id;
  assert.deepEqual(observed, candidate);
  assert.equal(callbacks, 1);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reads.length, 2);
});

test("a later commit remains intact and does not cause an ambiguous transaction to replay", async () => {
  const client = memoryBlob();
  client.onWrite = (text) => {
    client.commit(text);
    const later = client.state();
    later.commit_id = differentMarker(later.commit_id);
    later.usage.counter.used = 9;
    later.usage.external = { retained: true };
    client.commit(JSON.stringify(later));
    throw lostResponse();
  };
  let callbacks = 0;
  await assert.rejects(storeFor(client).mutateState((draft) => {
    callbacks++;
    return ++draft.usage.counter.used;
  }), { code: "write_unavailable" });
  assert.equal(client.state().usage.counter.used, 9);
  assert.deepEqual(client.state().usage.external, { retained: true });
  assert.equal(callbacks, 1);
  assert.equal(client.writes.length, 1);
});

test("a matching commit marker with different serialized content cannot confirm success", async () => {
  const client = memoryBlob();
  client.onWrite = (text) => {
    const altered = JSON.parse(text);
    altered.usage.counter.used = 7;
    client.commit(JSON.stringify(altered));
    throw lostResponse();
  };
  await assert.rejects(storeFor(client).mutateState((draft) => ++draft.usage.counter.used),
    { code: "write_unavailable" });
  assert.equal(client.state().commit_id, JSON.parse(client.writes[0].text).commit_id);
  assert.notEqual(JSON.stringify(client.state()), client.writes[0].text);
  assert.equal(client.state().usage.counter.used, 7);
  assert.equal(client.writes.length, 1);
});

test("failed reconciliation reads stay bounded and preserve the original write failure", async () => {
  const client = memoryBlob();
  client.onRead = (attempt) => { if (attempt > 1) throw lostResponse(); };
  client.onWrite = (text) => { client.commit(text); throw lostResponse(); };
  let pauses = 0;
  let callbacks = 0;
  await assert.rejects(storeFor(client, { pause: async () => { pauses++; } }).mutateState((draft) => {
    callbacks++;
    return ++draft.usage.counter.used;
  }), { code: "write_unavailable" });
  assert.equal(client.reads.length, 4, "One admission read plus the snapshot's three bounded attempts");
  assert.equal(pauses, 2);
  assert.equal(client.writes.length, 1);
  assert.equal(callbacks, 1);
  assert.equal(client.state().usage.counter.used, 1);
});

test("a missing reconciliation snapshot never initializes or overwrites account storage", async () => {
  const client = memoryBlob();
  client.onRead = (attempt) => attempt > 1 ? null : undefined;
  client.onWrite = () => { throw lostResponse(); };
  await assert.rejects(storeFor(client).mutateState((draft) => ++draft.usage.counter.used),
    { code: "write_unavailable" });
  assert.equal(client.reads.length, 2);
  assert.equal(client.writes.length, 1);
  assert.equal(client.state().usage.counter.used, 0);
});

test("reconciled shared batches execute every callback once and retain failed callback isolation", async () => {
  const client = memoryBlob();
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  client.onRead = async (attempt) => {
    if (attempt === 1) { enter(); await gate; }
  };
  client.onWrite = (text) => { client.commit(text); throw lostResponse(); };
  const store = storeFor(client);
  const callbacks = [0, 0, 0];
  const first = store.mutateState((draft) => { callbacks[0]++; return ++draft.usage.counter.used; });
  await entered;
  const rejected = store.mutateState((draft) => {
    callbacks[1]++;
    draft.usage.counter.used = 100;
    draft.users.partial = { mustNotPersist: true };
    throw new Error("invalid callback");
  }).then(() => null, (error) => error);
  const last = store.mutateState((draft) => { callbacks[2]++; return ++draft.usage.counter.used; });
  release();
  const [firstResult, failure, lastResult] = await Promise.all([first, rejected, last]);
  assert.equal(firstResult, 1);
  assert.equal(failure.message, "invalid callback");
  assert.equal(lastResult, 2);
  assert.deepEqual(callbacks, [1, 1, 1]);
  assert.equal(client.state().usage.counter.used, 2);
  assert.equal(client.state().users.partial, undefined);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reads.length, 2);
});

test("a no-op retains its existing commit marker without writing or reconciling", async () => {
  const marker = "a".repeat(32);
  const client = memoryBlob(initialState({ commit_id: marker }));
  const result = await storeFor(client).mutateState(() => "unchanged");
  assert.equal(result, "unchanged");
  assert.equal(client.state().commit_id, marker);
  assert.equal(client.reads.length, 1);
  assert.equal(client.writes.length, 0);
});

test("commit metadata cannot push a formerly valid candidate beyond the storage byte limit", async () => {
  const state = initialState();
  state.usage.padding = { text: "" };
  const baselineBytes = Buffer.byteLength(JSON.stringify(state));
  const client = memoryBlob(state);
  await assert.rejects(storeFor(client).mutateState((draft) => {
    draft.usage.padding.text = "x".repeat(4_000_000 - baselineBytes);
  }), { status: 503 });
  assert.equal(client.writes.length, 0);
  assert.equal(client.state().usage.padding.text, "");
  assert.equal(client.state().commit_id, undefined);
});

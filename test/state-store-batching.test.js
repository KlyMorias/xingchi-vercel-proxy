const test = require("node:test");
const assert = require("node:assert/strict");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const { createStateStore } = require("../lib/state-store");

const originalEnv = { ...process.env };
test.beforeEach(() => { process.env.BLOB_STORE_ID = "store_batch_test"; });
test.afterEach(() => { process.env = { ...originalEnv }; });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryBlob() {
  let current = JSON.stringify({ version: 1, users: {}, sessions: {}, keys: {}, usage: { counter: { used: 0 } },
    reservations: {}, login_attempts: {} });
  let revision = 1;
  const client = {
    reads: 0, attempts: [], commits: [], beforeGet: null, beforePut: null,
    async get() {
      this.reads++;
      const snapshot = current;
      const etag = `revision-${revision}`;
      if (this.beforeGet) await this.beforeGet();
      return { statusCode: 200, blob: { etag, size: Buffer.byteLength(snapshot) }, stream: new Response(snapshot).body };
    },
    async put(_path, text, options) {
      this.attempts.push({ state: JSON.parse(text), etag: options.ifMatch });
      if (this.beforePut) await this.beforePut(text, options);
      if (options.ifMatch !== `revision-${revision}`) throw new BlobPreconditionFailedError();
      current = text;
      revision++;
      this.commits.push(JSON.parse(text));
      return { etag: `revision-${revision}` };
    },
    externalCommit(edit) {
      const changed = JSON.parse(current);
      edit(changed);
      current = JSON.stringify(changed);
      revision++;
    },
    state: () => JSON.parse(current),
  };
  return client;
}

function firstReadGate(client) {
  const entered = deferred();
  const gate = deferred();
  let first = true;
  client.beforeGet = async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await gate.promise;
  };
  return { entered: entered.promise, release: gate.resolve };
}

const storeFor = (client) => createStateStore(client, { attempts: 12, pause: async () => {}, warn: () => {} });

test("overlapping mutations share commits and retain every ordered counter result", async () => {
  const client = memoryBlob();
  const gate = firstReadGate(client);
  const store = storeFor(client);
  const increment = (draft) => ++draft.usage.counter.used;
  const first = store.mutateState(increment);
  await gate.entered;
  const remaining = Array.from({ length: 7 }, () => store.mutateState(increment));
  gate.release();
  const results = await Promise.all([first, ...remaining]);
  assert.deepEqual(results, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(client.state().usage.counter.used, 8);
  assert.ok(client.commits.length >= 1 && client.commits.length <= 2,
    `Expected one or two shared commits, got ${client.commits.length}`);
  assert.equal(client.attempts.length, client.commits.length);
});

test("a coalesced quota boundary admits five of eight calls without overshooting", async () => {
  const client = memoryBlob();
  const gate = firstReadGate(client);
  const store = storeFor(client);
  const admit = (draft) => {
    if (draft.usage.counter.used >= 5) return { allowed: false };
    draft.usage.counter.used++;
    return { allowed: true };
  };
  const first = store.mutateState(admit);
  await gate.entered;
  const remaining = Array.from({ length: 7 }, () => store.mutateState(admit));
  gate.release();
  const results = await Promise.all([first, ...remaining]);
  assert.equal(results.filter((result) => result.allowed).length, 5);
  assert.equal(results.filter((result) => !result.allowed).length, 3);
  assert.equal(client.state().usage.counter.used, 5);
  assert.ok(client.commits.length <= 2);
});

test("a rejected callback cannot leak partial edits into another caller's commit", async () => {
  const client = memoryBlob();
  const gate = firstReadGate(client);
  const store = storeFor(client);
  const rejected = store.mutateState((draft) => {
    draft.usage.counter.used = 100;
    draft.users.partial = { username: "must-not-persist" };
    throw new Error("callback validation failure");
  });
  // Attach rejection handling before allowing the pending operation to run.
  const firstResult = rejected.then((value) => ({ value }), (error) => ({ error }));
  await gate.entered;
  const success = store.mutateState((draft) => ++draft.usage.counter.used);
  gate.release();
  const [failure, value] = await Promise.all([firstResult, success]);
  assert.equal(failure.error.message, "callback validation failure");
  assert.equal(value, 1);
  assert.equal(client.state().usage.counter.used, 1);
  assert.equal(client.state().users.partial, undefined);
});

test("cross-instance conflict refreshes state and replays the whole batch exactly once", async () => {
  const client = memoryBlob();
  const gate = firstReadGate(client);
  const store = storeFor(client);
  let firstWrite = true;
  client.beforePut = async () => {
    if (!firstWrite) return;
    firstWrite = false;
    client.externalCommit((draft) => { draft.usage.counter.used = 10; draft.usage.external = { keep: true }; });
  };
  const first = store.mutateState((draft) => ++draft.usage.counter.used);
  await gate.entered;
  const second = store.mutateState((draft) => ++draft.usage.counter.used);
  gate.release();
  assert.deepEqual(await Promise.all([first, second]), [11, 12]);
  assert.equal(client.state().usage.counter.used, 12);
  assert.deepEqual(client.state().usage.external, { keep: true });
  assert.ok(client.reads >= 2);
  assert.notEqual(client.attempts[0].etag, client.attempts[1].etag);
});

test("pending writes never resolve early and a failed write does not block following operations", async () => {
  const client = memoryBlob();
  const store = storeFor(client);
  const entered = deferred();
  const gate = deferred();
  let firstWrite = true;
  client.beforePut = async () => {
    if (!firstWrite) return;
    firstWrite = false;
    entered.resolve();
    await gate.promise;
    throw new TypeError("fetch failed");
  };
  let settled = false;
  const initial = store.mutateState((draft) => { draft.usage.counter.used = 100; });
  const observed = initial.then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  await entered.promise;
  const following = store.mutateState((draft) => ++draft.usage.counter.used);
  assert.equal(settled, false);
  assert.equal(client.state().usage.counter.used, 0);
  gate.resolve();
  const failure = await observed;
  assert.equal(failure.code, "write_unavailable");
  assert.equal(await following, 1);
  assert.equal(client.state().usage.counter.used, 1);
  assert.equal(client.commits.length, 1);
  assert.equal(client.attempts.length, 2);
});

test("an asynchronous callback is rejected without committing its isolated edits", async () => {
  const client = memoryBlob();
  const gate = firstReadGate(client);
  const store = storeFor(client);
  const invalid = store.mutateState(async (draft) => {
    draft.usage.counter.used = 100;
    await Promise.resolve();
    draft.usage.afterAwait = { secret: true };
  });
  const result = invalid.then(() => null, (error) => error);
  await gate.entered;
  const valid = store.mutateState((draft) => ++draft.usage.counter.used);
  gate.release();
  const error = await result;
  assert.match(error.message, /synchronous/i);
  assert.equal(await valid, 1);
  assert.equal(client.state().usage.counter.used, 1);
  assert.equal(client.state().usage.afterAwait, undefined);
});

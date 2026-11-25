const test = require("node:test");
const assert = require("node:assert/strict");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const { neonConfig } = require("@neondatabase/serverless");
const { createPostgresBlob, CREATE_TABLE_SQL, PATH, MAX_BYTES } = require("../lib/postgres-blob");
const { createStateStore } = require("../lib/state-store");

function stateText() {
  return JSON.stringify({ version: 1, users: {}, sessions: {}, keys: {},
    usage: { counter: { used: 0 } }, reservations: {}, login_attempts: {} });
}

async function configured(operation) {
  const original = process.env.BLOB_STORE_ID;
  process.env.BLOB_STORE_ID = "store_postgres_adapter_test";
  try { return await operation(); }
  finally {
    if (original === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = original;
  }
}

function memorySql(initial) {
  let row = initial ? { ...initial } : null;
  const calls = [];
  return {
    calls,
    current() { return row && { ...row }; },
    async query(sql, params, options) {
      calls.push({ sql, params, options });
      // Delay all callers before the atomic statement to exercise contention.
      await Promise.resolve();
      assert.equal(params[0], PATH);
      assert.equal(options.arrayMode, false);
      assert.equal(options.fullResults, false);
      assert.ok(options.fetchOptions.signal instanceof AbortSignal);
      if (sql.startsWith("SELECT")) {
        assert.match(sql, /version::text AS version/);
        assert.match(sql, /WHERE singleton_key = \$1$/);
        return row ? [{ ...row }] : [];
      }
      if (sql.startsWith("INSERT")) {
        assert.match(sql, /VALUES \(\$1, \$2\) ON CONFLICT \(singleton_key\) DO NOTHING/);
        assert.match(sql, /RETURNING version::text AS version$/);
        assert.equal(params.length, 2);
        if (row) return [];
        row = { payload: params[1], version: "1" };
      } else if (sql.startsWith("UPDATE")) {
        assert.match(sql, /SET payload = \$2, version = version \+ 1, updated_at = now\(\)/);
        assert.match(sql, /WHERE singleton_key = \$1 AND version = \$3::bigint\nRETURNING version::text AS version$/);
        assert.equal(params.length, 3);
        if (!row || row.version !== params[2]) return [];
        row = { payload: params[1], version: String(BigInt(row.version) + 1n) };
      } else {
        assert.fail("Unexpected SQL operation");
      }
      return [{ version: row.version }];
    },
  };
}

test("missing data returns null without creating a table or seeding state", async () => {
  const sql = memorySql();
  assert.equal(await createPostgresBlob(sql.query).get(PATH), null);
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /^SELECT/);
  assert.equal(sql.current(), null);
});

test("DDL creates only the bounded singleton text storage during explicit migration", () => {
  assert.match(CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS public\.klyapi_state/);
  assert.match(CREATE_TABLE_SQL, /singleton_key TEXT PRIMARY KEY CHECK \(singleton_key = 'klyapi\/state-v1\.json'\)/);
  assert.match(CREATE_TABLE_SQL, /payload TEXT NOT NULL CHECK \(octet_length\(payload\) <= 4000000\)/);
  assert.match(CREATE_TABLE_SQL, /version BIGINT NOT NULL DEFAULT 1 CHECK \(version > 0\)/);
  assert.match(CREATE_TABLE_SQL, /updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.doesNotMatch(CREATE_TABLE_SQL, /JSONB|INSERT|GRANT/i);
});

test("reads preserve exact text, UTF-8 byte size and 64-bit ETag precision", async () => {
  const payload = '{\n  "token": "雪🦊", "n": 1.00, "escaped": "\\u0061"\n}\n';
  const version = "9007199254740993";
  const sql = memorySql({ payload, version });
  const result = await createPostgresBlob(sql.query).get(PATH, { access: "private", useCache: false });
  assert.equal(result.statusCode, 200);
  assert.equal(result.blob.size, Buffer.byteLength(payload));
  assert.equal(result.blob.etag, version);
  assert.equal(await new Response(result.stream).text(), payload);
  assert.equal(sql.calls.length, 1);
});

test("parallel bootstrap creates only one authoritative snapshot", async () => {
  const sql = memorySql();
  const client = createPostgresBlob(sql.query);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
    client.put(PATH, `snapshot-${index}`, { allowOverwrite: false })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(results.find((result) => result.status === "fulfilled").value, { etag: "1" });
  const rejected = results.filter((result) => result.status === "rejected");
  assert.ok(rejected.every((result) => result.reason instanceof BlobPreconditionFailedError));
  assert.equal(sql.current().payload, "snapshot-0");
  assert.equal(sql.current().version, "1");
  assert.equal(sql.calls.length, 12);
  assert.ok(sql.calls.every((call) => call.sql.startsWith("INSERT")));
});

test("parallel CAS allows one writer and preserves the winning exact text", async () => {
  const sql = memorySql({ payload: "original", version: "9007199254740993" });
  const client = createPostgresBlob(sql.query);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
    client.put(PATH, `writer-${index}\n`, { allowOverwrite: true, ifMatch: "9007199254740993" })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(results.find((result) => result.status === "fulfilled").value, { etag: "9007199254740994" });
  assert.ok(results.filter((result) => result.status === "rejected")
    .every((result) => result.reason instanceof BlobPreconditionFailedError));
  assert.deepEqual(sql.current(), { payload: "writer-0\n", version: "9007199254740994" });
  assert.equal(sql.calls.length, 12);
  assert.ok(sql.calls.every((call) => call.sql.startsWith("UPDATE")));
});

test("existing state-store CAS retries preserve every cross-instance mutation through the adapter", async () => {
  await configured(async () => {
    const sql = memorySql({ payload: stateText(), version: "1" });
    const client = createPostgresBlob(sql.query);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () =>
      createStateStore(client, { attempts: 20, pause: async () => {}, warn: () => {} })
        .mutateState((state) => ++state.usage.counter.used)));
    assert.deepEqual(outcomes.sort((left, right) => left - right), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(JSON.parse(sql.current().payload).usage.counter.used, 12);
    assert.equal(sql.current().version, "13");
    assert.match(JSON.parse(sql.current().payload).commit_id, /^[a-f0-9]{32}$/);
  });
});

test("a committed SQL write with a lost response reconciles without replaying the mutation", async () => {
  await configured(async () => {
    const sql = memorySql({ payload: stateText(), version: "1" });
    const client = createPostgresBlob(async (...args) => {
      const rows = await sql.query(...args);
      if (args[0].startsWith("UPDATE")) throw new Error("private connection URL and account data");
      return rows;
    });
    const logs = [];
    let callbacks = 0;
    const store = createStateStore(client, { pause: async () => {}, warn: (entry) => logs.push(entry) });
    assert.equal(await store.mutateState((state) => { callbacks++; return ++state.usage.counter.used; }), 1);
    assert.equal(callbacks, 1);
    assert.equal(sql.calls.filter((call) => call.sql.startsWith("UPDATE")).length, 1);
    assert.equal(JSON.parse(sql.current().payload).usage.counter.used, 1);
    assert.equal(JSON.stringify(logs).includes("private"), false);
    assert.ok(logs.some((entry) => entry.phase === "reconcile" && entry.reason === "confirmed"));
  });
});

test("CAS cannot create a missing row, revive a stale version or overwrite unconditionally", async () => {
  const sql = memorySql();
  const client = createPostgresBlob(sql.query);
  await assert.rejects(client.put(PATH, "missing", { ifMatch: "1" }), BlobPreconditionFailedError);
  await client.put(PATH, "original", { allowOverwrite: false });
  await client.put(PATH, "updated", { ifMatch: "1" });
  await assert.rejects(client.put(PATH, "stale", { ifMatch: "1" }), BlobPreconditionFailedError);
  const calls = sql.calls.length;
  for (const options of [{}, { allowOverwrite: true }, { ifMatch: "" }, { ifMatch: 2 },
    { ifMatch: "W/2" }, { ifMatch: "02" }, { ifMatch: "9223372036854775808" },
    { allowOverwrite: false, ifMatch: "2" }]) {
    await assert.rejects(client.put(PATH, "unguarded", options), { code: "postgres_invalid_request" });
  }
  assert.equal(sql.calls.length, calls);
  assert.deepEqual(sql.current(), { payload: "updated", version: "2" });
});

test("SQL values are parameters and the adapter accepts only its fixed path", async () => {
  const sql = memorySql();
  const client = createPostgresBlob(sql.query);
  const payload = "private-token'; DROP TABLE public.klyapi_state; --\n{}";
  await client.put(PATH, payload, { allowOverwrite: false });
  await client.put(PATH, payload, { ifMatch: "1" });
  for (const call of sql.calls) {
    assert.equal(call.params[1], payload);
    assert.equal(call.sql.includes(payload), false);
    assert.equal(call.sql.includes("private-token"), false);
  }
  const before = sql.calls.length;
  await assert.rejects(client.get("elsewhere"), { code: "postgres_invalid_request" });
  await assert.rejects(client.put("elsewhere", "x", { allowOverwrite: false }), { code: "postgres_invalid_request" });
  assert.equal(sql.calls.length, before);
});

test("the payload limit is measured in UTF-8 bytes for both reads and writes", async () => {
  const sql = memorySql();
  const client = createPostgresBlob(sql.query);
  const maximum = "é".repeat(MAX_BYTES / 2);
  await client.put(PATH, maximum, { allowOverwrite: false });
  assert.equal((await client.get(PATH)).blob.size, MAX_BYTES);
  const before = sql.calls.length;
  await assert.rejects(client.put(PATH, maximum + "é", { ifMatch: "1" }), { code: "postgres_invalid_request" });
  assert.equal(sql.calls.length, before);
  assert.equal(sql.current().payload, maximum);
  await assert.rejects(createPostgresBlob(async () => [{ payload: maximum + "é", version: "1" }]).get(PATH),
    { code: "postgres_unavailable" });
});

test("corrupt query results fail closed", async () => {
  for (const result of [null, {}, [{ payload: "{}", version: 1 }], [{ payload: "{}", version: "0" }],
    [{ payload: "{}", version: "9223372036854775808" }], [{ payload: null, version: "1" }],
    [{ payload: "{}", version: "1" }, { payload: "{}", version: "2" }]]) {
    await assert.rejects(createPostgresBlob(async () => result).get(PATH), { code: "postgres_unavailable" });
  }
  await assert.rejects(createPostgresBlob(async () => [{ version: 1 }]).put(PATH, "{}", { allowOverwrite: false }),
    { code: "postgres_unavailable" });
});

test("missing schema and database errors expose no SQL, connection strings or raw details", async () => {
  const secret = "postgresql://private-user:private-password@private-host/db account-data SQL";
  let queries = 0;
  const client = createPostgresBlob(async (sql) => {
    queries++;
    assert.match(sql, /^SELECT/);
    throw Object.assign(new Error(secret), { code: "42P01", detail: secret, cause: new Error(secret) });
  });
  await assert.rejects(client.get(PATH), (error) => {
    assert.equal(error.message, "PostgreSQL storage unavailable");
    assert.equal(error.statusCode, 503);
    assert.equal(error.cause, undefined);
    assert.equal(error.detail, undefined);
    assert.equal(JSON.stringify(error).includes("private"), false);
    return true;
  });
  assert.equal(queries, 1);
  for (const [raw, status] of [[{ code: "28P01", message: secret }, 403],
    [{ message: `Server error (HTTP status 429): ${secret}` }, 429], [{ message: secret }, 503]]) {
    await assert.rejects(createPostgresBlob(async () => { throw raw; }).get(PATH), (error) =>
      error.message === "PostgreSQL storage unavailable" && error.statusCode === status && error.cause === undefined);
  }
});

test("already aborted requests do not issue SQL and never leak the abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private abort detail"));
  let queries = 0;
  const client = createPostgresBlob(async () => { queries++; return []; });
  for (const request of [client.get(PATH, { abortSignal: controller.signal }),
    client.put(PATH, "{}", { allowOverwrite: false, abortSignal: controller.signal })]) {
    await assert.rejects(request, (error) => error.name === "AbortError" && error.message === "Storage request aborted");
  }
  assert.equal(queries, 0);
});

test("an in-flight abort reaches the driver and ends even a non-cooperating query", async () => {
  const controller = new AbortController();
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  let receivedSignal;
  let queries = 0;
  const client = createPostgresBlob(async (_sql, _params, options) => {
    queries++;
    receivedSignal = options.fetchOptions.signal;
    started();
    return new Promise(() => {});
  });
  const request = client.put(PATH, "{}", { allowOverwrite: false, abortSignal: controller.signal });
  await start;
  controller.abort(new Error("private reason"));
  await assert.rejects(request, { name: "AbortError", message: "Storage request aborted" });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(queries, 1);
});

test("query timeouts are bounded, abort HTTP and do not retry an ambiguous write", async () => {
  let receivedSignal;
  let queries = 0;
  const client = createPostgresBlob(async (_sql, _params, options) => {
    queries++;
    receivedSignal = options.fetchOptions.signal;
    return new Promise(() => {});
  }, { timeoutMs: 15 });
  const start = Date.now();
  await assert.rejects(client.put(PATH, "{}", { allowOverwrite: false }),
    { name: "TimeoutError", message: "Storage request timed out" });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(queries, 1);
  assert.ok(Date.now() - start < 1000);
  for (const timeoutMs of [0, -1, 1.5, 10001, Infinity]) {
    assert.throws(() => createPostgresBlob(async () => [], { timeoutMs }), { code: "postgres_invalid_request" });
  }
});

test("the default client uses the official Neon driver, HTTPS and the cancellable fetch options", async () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalFetch = neonConfig.fetchFunction;
  process.env.DATABASE_URL = "postgresql://test_user:test_password@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require";
  let requests = 0;
  neonConfig.fetchFunction = async (url, options) => {
    requests++;
    assert.match(String(url), /^https:\/\/[^/]+\/sql$/);
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers["Neon-Connection-String"].includes("test_password"), true);
    const { query, params } = JSON.parse(options.body);
    assert.match(query, /^SELECT payload, version::text AS version/);
    assert.deepEqual(params, [PATH]);
    return new Response(JSON.stringify({ fields: [{ name: "payload", dataTypeID: 25 }, { name: "version", dataTypeID: 25 }],
      rows: [["{\n}\n", "42"]], command: "SELECT", rowCount: 1 }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await createPostgresBlob().get(PATH);
    assert.equal(result.blob.etag, "42");
    assert.equal(await new Response(result.stream).text(), "{\n}\n");
    assert.equal(requests, 1);
    delete process.env.DATABASE_URL;
    await assert.rejects(createPostgresBlob().get(PATH), { code: "postgres_unavailable" });
    assert.equal(requests, 1);
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    neonConfig.fetchFunction = originalFetch;
  }
});

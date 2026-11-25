const { ReadableStream } = require("node:stream/web");
const { neon } = require("@neondatabase/serverless");
const { BlobPreconditionFailedError } = require("@vercel/blob");

const PATH = "klyapi/state-v1.json";
const MAX_BYTES = 4_000_000;
const MAX_VERSION = 9223372036854775807n;

// Run only during an explicit migration. Reads and writes deliberately never
// create a missing table or replace an existing account snapshot.
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS public.klyapi_state (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'klyapi/state-v1.json'),
  payload TEXT NOT NULL CHECK (octet_length(payload) <= 4000000),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const READ_SQL = `SELECT payload, version::text AS version
FROM public.klyapi_state WHERE singleton_key = $1`;
const CREATE_SQL = `INSERT INTO public.klyapi_state (singleton_key, payload)
VALUES ($1, $2) ON CONFLICT (singleton_key) DO NOTHING
RETURNING version::text AS version`;
const UPDATE_SQL = `UPDATE public.klyapi_state
SET payload = $2, version = version + 1, updated_at = now()
WHERE singleton_key = $1 AND version = $3::bigint
RETURNING version::text AS version`;

function failure(code = "postgres_unavailable", statusCode = 503) {
  return Object.assign(new Error("PostgreSQL storage unavailable"), { code, statusCode });
}

function cancellation(timedOut) {
  return Object.assign(new Error(timedOut ? "Storage request timed out" : "Storage request aborted"),
    { name: timedOut ? "TimeoutError" : "AbortError" });
}

function validVersion(value) {
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_VERSION;
}

function safeDatabaseError(error) {
  // Driver errors may contain a connection URL, SQL text, parameters or account
  // data. Propagate only fixed messages and a small, known set of status codes.
  if (["28000", "28P01", "42501"].includes(error?.code)) return failure("postgres_auth", 403);
  const status = /^Server error \(HTTP status (401|403|429|500|502|503|504)\):/.exec(String(error?.message || ""));
  return failure("postgres_unavailable", status ? Number(status[1]) : 503);
}

// query follows neon(...).query(text, params, options). Dependency injection is
// useful for tests and explicit migration tooling; the runtime uses HTTPS Neon
// SQL with the driver's connection authentication and TLS defaults.
function createPostgresBlob(query, { timeoutMs = 10000 } = {}) {
  if (query !== undefined && typeof query !== "function") throw failure("postgres_invalid_request");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw failure("postgres_invalid_request");
  let runtimeQuery = query;

  function getQuery() {
    if (!runtimeQuery) {
      if (!process.env.DATABASE_URL) throw failure();
      runtimeQuery = neon(process.env.DATABASE_URL).query;
    }
    return runtimeQuery;
  }

  async function runQuery(text, params, abortSignal) {
    if (abortSignal !== undefined && (!abortSignal || typeof abortSignal.addEventListener !== "function"
      || typeof abortSignal.removeEventListener !== "function" || typeof abortSignal.aborted !== "boolean")) {
      throw failure("postgres_invalid_request");
    }
    if (abortSignal?.aborted) throw cancellation(false);
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      controller.abort();
      rejectAbort(cancellation(timedOut));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
    try {
      // The local race also bounds an injected query which ignores the signal.
      // A timed-out write is ambiguous; this adapter never retries it.
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancellation(timedOut);
        return getQuery()(text, params, { arrayMode: false, fullResults: false,
          fetchOptions: { signal: controller.signal } });
      });
      const rows = await Promise.race([pending, aborted]);
      if (!Array.isArray(rows) || rows.length > 1) throw failure();
      return rows;
    } catch (error) {
      if (controller.signal.aborted) throw cancellation(timedOut);
      throw safeDatabaseError(error);
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  function checkPath(path) {
    if (path !== PATH) throw failure("postgres_invalid_request");
  }

  return {
    requiresMigration: true,
    async get(path, options = {}) {
      checkPath(path);
      const rows = await runQuery(READ_SQL, [PATH], options.abortSignal);
      if (!rows.length) return null;
      const { payload, version } = rows[0];
      if (typeof payload !== "string" || !validVersion(version)) throw failure();
      const bytes = Buffer.from(payload, "utf8");
      if (bytes.length > MAX_BYTES) throw failure();
      return { statusCode: 200, blob: { etag: version, size: bytes.length },
        stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    },
    async put(path, text, options = {}) {
      checkPath(path);
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw failure("postgres_invalid_request");
      let sql;
      let params;
      if (options.allowOverwrite === false && options.ifMatch === undefined) {
        sql = CREATE_SQL;
        params = [PATH, text];
      } else if (options.allowOverwrite !== false && validVersion(options.ifMatch)) {
        sql = UPDATE_SQL;
        params = [PATH, text, options.ifMatch];
      } else {
        // No unconditional overwrite path exists, even for an absent row.
        throw failure("postgres_invalid_request");
      }
      const rows = await runQuery(sql, params, options.abortSignal);
      if (!rows.length) throw new BlobPreconditionFailedError();
      if (!validVersion(rows[0].version)) throw failure();
      return { etag: rows[0].version };
    },
  };
}

module.exports = { createPostgresBlob, CREATE_TABLE_SQL, PATH, MAX_BYTES };

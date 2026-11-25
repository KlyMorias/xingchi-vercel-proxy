const crypto = require("node:crypto");
const blob = require("@vercel/blob");
const { createPostgresBlob } = require("./postgres-blob");

// A lost write response must not become a retried CAS conflict inside the SDK.
// This store owns bounded read, throttling and conditional-write retries.
process.env.VERCEL_BLOB_RETRIES = "0";

const PATH = "klyapi/state-v1.json";
const MAX_BYTES = 4_000_000;

function unavailable(code = "storage_unavailable") {
  return Object.assign(new Error("Hesap servisine şu anda ulaşılamıyor. Lütfen tekrar deneyin."),
    { status: 503, statusCode: 503, code });
}

function isConfigured() {
  return Boolean(process.env.DATABASE_URL || process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function validate(state) {
  if (!state || state.version !== 1) throw unavailable();
  for (const name of ["users", "sessions", "keys", "usage", "reservations", "login_attempts"]) {
    if (!state[name] || typeof state[name] !== "object" || Array.isArray(state[name])) throw unavailable();
  }
  return state;
}

function seedState() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD_HASH;
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username || "") || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(password || "")) {
    throw unavailable();
  }
  const admin = { id: crypto.randomBytes(16).toString("hex"), username, role: "admin", enabled: true,
    password_hash: password, session_version: 1, hourly_limit: 20, daily_limit: 50, weekly_limit: 200, requests_per_minute: 5,
    created_at: new Date().toISOString() };
  return { version: 1, users: { [username.toLowerCase()]: admin }, sessions: {}, keys: {},
    usage: {}, reservations: {}, login_attempts: {} };
}

function cleanup(state) {
  const now = Math.floor(Date.now() / 1000);
  for (const name of ["sessions", "keys", "reservations", "login_attempts"]) {
    for (const [key, value] of Object.entries(state[name])) {
      if (value.expires_at && value.expires_at <= now) delete state[name][key];
    }
  }
}

function createStateStore(client = process.env.DATABASE_URL ? createPostgresBlob() : blob,
  { attempts = 12, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn = (entry) => console.warn(entry), now = Date.now } = {}) {
  const operationBudget = 15000;
  const blobStorage = client.requiresMigration !== true;
  const blobWriteOptions = blobStorage
    ? { addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60 } : {};
  const options = (deadline) => ({ ...(blobStorage ? { access: "private", ...(process.env.BLOB_READ_WRITE_TOKEN
    ? { token: process.env.BLOB_READ_WRITE_TOKEN }
    : process.env.BLOB_STORE_ID ? { storeId: process.env.BLOB_STORE_ID } : {}) } : {}),
    abortSignal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))) });
  const conflict = (error) => error instanceof blob.BlobPreconditionFailedError
    || /precondition|already exists/i.test(error?.message || "")
    // Blob sometimes reports simultaneous conditional writes as a generic
    // bad-request error instead of BlobPreconditionFailedError. The request
    // explicitly did not succeed: reload its ETag and retry the mutation.
    || /^(?:Vercel Blob: )?The conditional request cannot succeed due to a conflicting operation against this resource\.$/.test(error?.message || "");

  // Classify locally; diagnostics contain enums only, never SDK messages,
  // credentials, URLs or stored account data.
  function reasonFor(error) {
    if (conflict(error)) return "conflict";
    if (["storage_unavailable", "read_unavailable", "write_unavailable"].includes(error?.code)) return "invalid";
    const name = error?.constructor?.name || error?.name || "";
    const status = Number(error?.statusCode || error?.status || error?.response?.status);
    const message = String(error?.message || "");
    if (name === "BlobServiceRateLimited" || status === 429 || /fetch blob:\s*429\b/i.test(message)) return "ratelimit";
    if (name === "BlobAccessError" || name === "BlobClientTokenExpiredError" || [401, 403].includes(status)
      || /fetch blob:\s*(401|403)\b|invalid token|oidc.*not.*allowed/i.test(message)) return "auth";
    if (name === "BlobServiceNotAvailable" || [500, 502, 503, 504].includes(status)
      || /fetch blob:\s*5(?:00|02|03|04)\b/i.test(message)) return "unavailable";
    if (["AbortError", "TimeoutError", "BlobRequestAbortedError"].includes(error?.name)
      || name === "BlobRequestAbortedError" || /^(?:fetch failed|network error|network request failed)$/i.test(message)
      || /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|UND_ERR_)/.test(error?.code || "")
      || /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|UND_ERR_)/.test(error?.cause?.code || "")) return "network";
    return "invalid";
  }
  function diagnostic(phase, reason, attempt, error) {
    const entry = { scope: "storage", phase, reason, attempt };
    if (reason === "invalid") {
      const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : undefined;
      const sdkClass = identifier(error?.constructor?.name || error?.name);
      const sdkCode = identifier(error?.code || error?.cause?.code);
      const status = Number(error?.statusCode || error?.status || error?.response?.status);
      if (sdkClass) entry.sdkClass = sdkClass;
      if (sdkCode) entry.sdkCode = sdkCode;
      if (Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
      // Read the SDK message only to choose a fixed enum; never emit it.
      const message = String(error?.message || "");
      if (/\boidc\b/i.test(message)) entry.hint = "oidc";
      else if (/\bdelegation\b/i.test(message)) entry.hint = "delegation";
      else if (/\bnonce\b/i.test(message)) entry.hint = "nonce";
      else if (/\bjwt\b/i.test(message)) entry.hint = "jwt";
    }
    warn(entry);
  }
  async function retryPause(error, attempt, deadline) {
    const remaining = deadline - now();
    const advertised = Number(error?.retryAfter);
    const delay = Number.isFinite(advertised) && advertised > 0 ? Math.ceil(advertised * 1000)
      : Math.min(1000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
    if (delay >= remaining) return false;
    await pause(delay);
    return now() < deadline;
  }
  async function withTransientRetry(phase, maximum, deadline, operation, conflictAttempt = 1) {
    for (let attempt = 0; attempt < maximum; attempt++) {
      if (now() >= deadline) throw unavailable(`${phase}_unavailable`);
      let timer;
      try {
        const timeoutMs = Math.max(1, Math.min(10000, deadline - now()));
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("Storage timeout"), { name: "TimeoutError" })), timeoutMs);
        });
        return await Promise.race([operation(options(deadline)), timeout]);
      } catch (error) {
        const reason = reasonFor(error);
        diagnostic(phase, reason, reason === "conflict" ? conflictAttempt : attempt + 1, error);
        if (reason === "conflict") throw error;
        // A failed write may have committed before its response was lost.
        // Only explicit throttling is retried here; repeating an ambiguous
        // write could later repeat the caller's quota increment after a CAS.
        const transient = phase === "write" ? reason === "ratelimit" : ["network", "ratelimit", "unavailable"].includes(reason);
        if (!transient || attempt + 1 >= maximum
          || !(await retryPause(error, attempt, deadline))) {
          const failure = unavailable(`${phase}_unavailable`);
          if (phase === "write" && ["network", "unavailable"].includes(reason)) failure.ambiguousWrite = true;
          throw failure;
        }
      } finally { clearTimeout(timer); }
    }
    throw unavailable(`${phase}_unavailable`);
  }

  async function snapshot({ budgetMs = operationBudget } = {}) {
    if (!isConfigured()) throw unavailable();
    // Compressed delivery changes a strong storage ETag to a weak W/ ETag.
    // Request the stored representation so conditional writes use the exact
    // strong ETag issued by origin rather than retrying a permanent mismatch.
    const deadline = now() + budgetMs;
    return withTransientRetry("read", 3, deadline, async (operationOptions) => {
      const result = await client.get(PATH, { ...operationOptions,
        ...(blobStorage ? { useCache: false, headers: { "accept-encoding": "identity" } } : {}) });
      if (!result) return null;
      if (result.statusCode !== 200) throw Object.assign(new Error("Blob read status"), { statusCode: result.statusCode });
      if (!result.stream || result.blob?.size > MAX_BYTES) throw unavailable();
      const text = await new Response(result.stream).text();
      if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
      const state = validate(JSON.parse(text));
      if (!result.blob?.etag) throw unavailable();
      return { state, etag: result.blob.etag };
    });
  }

  async function write(text, writeOptions, conflictAttempt = 1) {
    const deadline = now() + operationBudget;
    return withTransientRetry("write", 5, deadline,
      (operationOptions) => client.put(PATH, text, { ...operationOptions, ...writeOptions }), conflictAttempt);
  }

  async function load() {
    try {
      const existing = await snapshot();
      if (existing) return existing;
      // PostgreSQL is activated only after an explicit, verified migration.
      // A missing singleton must never silently replace the account snapshot.
      if (client.requiresMigration === true) throw unavailable();
      const state = seedState();
      try {
        const result = await write(JSON.stringify(state), { ...blobWriteOptions, allowOverwrite: false });
        if (!result.etag) throw unavailable();
        return { state, etag: result.etag };
      } catch (error) {
        if (!conflict(error)) throw error;
        const existingAfterRace = await snapshot();
        if (!existingAfterRace) throw unavailable();
        return existingAfterRace;
      }
    } catch (error) { throw ["read_unavailable", "write_unavailable"].includes(error?.code) ? error : unavailable(); }
  }

  async function readState() {
    return (await load()).state;
  }

  const pendingMutations = [];
  const maxBatchSize = 64;
  const maxPendingMutations = 1024;
  let flushing = false;

  function settleBatch(batch, outcomes, failure) {
    batch.forEach((member, index) => {
      const outcome = outcomes?.[index];
      if (outcome?.failed) member.reject(outcome.error);
      else if (failure) member.reject(failure);
      else member.resolve(outcome.result);
    });
  }

  async function commitBatch(batch, firstSnapshot) {
    let outcomes;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { state, etag } = attempt === 0 ? firstSnapshot : await load();
      let draft = structuredClone(state);
      cleanup(draft);
      outcomes = [];
      for (const member of batch) {
        // A failed or asynchronous callback owns only its disposable draft;
        // it cannot leak a partial mutation into another queued operation.
        try {
          const candidate = structuredClone(draft);
          const result = member.callback(candidate);
          if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {});
            throw new Error("State mutation must be synchronous");
          }
          validate(candidate);
          if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_BYTES) throw unavailable();
          draft = candidate;
          outcomes.push({ result });
        } catch (error) { outcomes.push({ failed: true, error }); }
      }
      if (outcomes.every((outcome) => outcome.failed)) {
        settleBatch(batch, outcomes);
        return;
      }
      if (JSON.stringify(draft) === JSON.stringify(state)) {
        settleBatch(batch, outcomes);
        return;
      }
      // A unique commit marker distinguishes this write from a concurrent
      // mutation with identical business data if the PUT response is lost.
      draft.commit_id = crypto.randomBytes(16).toString("hex");
      const text = JSON.stringify(draft);
      if (Buffer.byteLength(text) > MAX_BYTES) {
        settleBatch(batch, outcomes, unavailable("write_unavailable"));
        return;
      }
      try {
        await write(text, { ...blobWriteOptions, allowOverwrite: true, ifMatch: etag }, attempt + 1);
        // Return every successful result only after their shared conditional
        // write has committed. Cross-instance conflicts replay the entire
        // batch against a fresh authoritative snapshot instead.
        settleBatch(batch, outcomes);
        return;
      } catch (error) {
        if (!conflict(error)) {
          if (error.ambiguousWrite) {
            try {
              const confirmed = await snapshot({ budgetMs: 2000 });
              if (confirmed?.state.commit_id === draft.commit_id && JSON.stringify(confirmed.state) === text) {
                // Confirm the exact committed snapshot without replaying any
                // callbacks, quota increments, key issuance or session writes.
                diagnostic("reconcile", "confirmed", attempt + 1, error);
                settleBatch(batch, outcomes);
                return;
              }
            } catch { /* Uncertain writes remain failures; never replay them. */ }
          }
          settleBatch(batch, outcomes, error?.code === "write_unavailable" ? error : unavailable("write_unavailable"));
          return;
        }
        if (attempt + 1 < attempts) await pause(Math.min(300, 20 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 30));
      }
    }
    settleBatch(batch, outcomes, Object.assign(unavailable(), { code: "storage_busy", retryAfter: 2 }));
  }

  async function flushMutations() {
    try {
      while (pendingMutations.length) {
        let batch;
        try {
          // Start the fresh read immediately. Requests arriving during that
          // I/O join this commit without an artificial batching delay.
          const snapshot = await load();
          batch = pendingMutations.splice(0, maxBatchSize);
          await commitBatch(batch, snapshot);
        } catch (error) {
          // Read failures and unexpected callback infrastructure errors must
          // reject their callers without poisoning later queued work.
          settleBatch(batch || pendingMutations.splice(0, maxBatchSize), null, error);
        }
      }
    } finally { flushing = false; }
  }

  function mutateState(callback) {
    if (typeof callback !== "function") return Promise.reject(new TypeError("State mutation must be a function"));
    if (pendingMutations.length >= maxPendingMutations) {
      return Promise.reject(Object.assign(unavailable(), { code: "storage_busy", retryAfter: 2 }));
    }
    return new Promise((resolve, reject) => {
      pendingMutations.push({ callback, resolve, reject });
      if (!flushing) {
        flushing = true;
        void flushMutations();
      }
    });
  }
  return { readState, mutateState, isConfigured };
}

module.exports = { ...createStateStore(), createStateStore, isConfigured };

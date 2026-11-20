const crypto = require("node:crypto");
const blob = require("@vercel/blob");

const PATH = "klyapi/state-v1.json";
const MAX_BYTES = 4_000_000;

function unavailable(code = "storage_unavailable") {
  return Object.assign(new Error("Hesap servisine şu anda ulaşılamıyor. Lütfen tekrar deneyin."),
    { status: 503, statusCode: 503, code });
}

function isConfigured() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
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
    password_hash: password, session_version: 1, daily_limit: 50, requests_per_minute: 5,
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

function createStateStore(client = blob, { attempts = 12, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn = (entry) => console.warn(entry), now = Date.now } = {}) {
  const operationBudget = 15000;
  const options = (deadline) => ({ access: "private", ...(process.env.BLOB_STORE_ID ? { storeId: process.env.BLOB_STORE_ID } : {}),
    abortSignal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))) });
  const conflict = (error) => error instanceof blob.BlobPreconditionFailedError
    || /precondition|already exists/i.test(error?.message || "");

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
  function diagnostic(phase, reason, attempt) { warn({ scope: "storage", phase, reason, attempt }); }
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
        diagnostic(phase, reason, reason === "conflict" ? conflictAttempt : attempt + 1);
        if (reason === "conflict") throw error;
        // A failed write may have committed before its response was lost.
        // Only explicit throttling is retried here; repeating an ambiguous
        // write could later repeat the caller's quota increment after a CAS.
        const transient = phase === "write" ? reason === "ratelimit" : ["network", "ratelimit", "unavailable"].includes(reason);
        if (!transient || attempt + 1 >= maximum
          || !(await retryPause(error, attempt, deadline))) throw unavailable(`${phase}_unavailable`);
      } finally { clearTimeout(timer); }
    }
    throw unavailable(`${phase}_unavailable`);
  }

  async function snapshot() {
    if (!isConfigured()) throw unavailable();
    // Compressed delivery changes a strong storage ETag to a weak W/ ETag.
    // Request the stored representation so conditional writes use the exact
    // strong ETag issued by origin rather than retrying a permanent mismatch.
    const deadline = now() + operationBudget;
    return withTransientRetry("read", 3, deadline, async (operationOptions) => {
      const result = await client.get(PATH, { ...operationOptions, useCache: false, headers: { "accept-encoding": "identity" } });
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
      const state = seedState();
      try {
        const result = await write(JSON.stringify(state), { addRandomSuffix: false,
          allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
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

  async function mutateState(callback) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { state, etag } = await load();
      const draft = structuredClone(state);
      cleanup(draft);
      const result = callback(draft);
      if (result && typeof result.then === "function") throw new Error("State mutation must be synchronous");
      validate(draft);
      const text = JSON.stringify(draft);
      if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
      if (text === JSON.stringify(state)) return result;
      try {
        await write(text, { addRandomSuffix: false, allowOverwrite: true,
          ifMatch: etag, contentType: "application/json", cacheControlMaxAge: 60 }, attempt + 1);
        return result;
      } catch (error) {
        if (!conflict(error)) throw error?.code === "write_unavailable" ? error : unavailable("write_unavailable");
        if (attempt + 1 < attempts) await pause(Math.min(300, 20 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 30));
      }
    }
    throw Object.assign(unavailable(), { code: "storage_busy", retryAfter: 2 });
  }
  return { readState, mutateState, isConfigured };
}

module.exports = { ...createStateStore(), createStateStore, isConfigured };

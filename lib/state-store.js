const crypto = require("node:crypto");
const blob = require("@vercel/blob");

const PATH = "klyapi/state-v1.json";
const MAX_BYTES = 4_000_000;

function unavailable() {
  return Object.assign(new Error("Hesap servisine şu anda ulaşılamıyor. Lütfen tekrar deneyin."),
    { status: 503, statusCode: 503, code: "storage_unavailable" });
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

function createStateStore(client = blob, { attempts = 12, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const options = () => ({ access: "private", ...(process.env.BLOB_STORE_ID ? { storeId: process.env.BLOB_STORE_ID } : {}),
    abortSignal: AbortSignal.timeout(15000) });
  const conflict = (error) => error instanceof blob.BlobPreconditionFailedError
    || /precondition|already exists/i.test(error?.message || "");

  async function snapshot() {
    if (!isConfigured()) throw unavailable();
    // Compressed delivery changes a strong storage ETag to a weak W/ ETag.
    // Request the stored representation so conditional writes use the exact
    // strong ETag issued by origin rather than retrying a permanent mismatch.
    const result = await client.get(PATH, { ...options(), useCache: false, headers: { "accept-encoding": "identity" } });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream || result.blob?.size > MAX_BYTES) throw unavailable();
    const text = await new Response(result.stream).text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
    const state = validate(JSON.parse(text));
    if (!result.blob?.etag) throw unavailable();
    return { state, etag: result.blob.etag };
  }

  async function load() {
    try {
      const existing = await snapshot();
      if (existing) return existing;
      const state = seedState();
      try {
        const result = await client.put(PATH, JSON.stringify(state), { ...options(), addRandomSuffix: false,
          allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
        if (!result.etag) throw unavailable();
        return { state, etag: result.etag };
      } catch (error) {
        if (!conflict(error)) throw error;
        const existingAfterRace = await snapshot();
        if (!existingAfterRace) throw unavailable();
        return existingAfterRace;
      }
    } catch { throw unavailable(); }
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
        await client.put(PATH, text, { ...options(), addRandomSuffix: false, allowOverwrite: true,
          ifMatch: etag, contentType: "application/json", cacheControlMaxAge: 60 });
        return result;
      } catch (error) {
        if (!conflict(error)) throw unavailable();
        if (attempt + 1 < attempts) await pause(Math.min(300, 20 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 30));
      }
    }
    throw Object.assign(unavailable(), { code: "storage_busy", retryAfter: 2 });
  }
  return { readState, mutateState, isConfigured };
}

module.exports = { ...createStateStore(), createStateStore, isConfigured };

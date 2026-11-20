const crypto = require("node:crypto");

const DAILY_LIMIT = 50;
const MINUTE_LIMIT = 5;
const KEY_LIFETIME = 30 * 24 * 60 * 60;
const PREFIX = "kly:";
const serviceInfo = Object.freeze({
  model: "gpt-6.1-sol",
  generation_available: true,
  message: "gpt-6.1-sol erişimi açık. OpenAI veya Anthropic uyumlu uygulamanı bağlayabilirsin.",
});

class StoreError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

function unavailable() {
  return new StoreError(503, "storage_unavailable", "Anahtar servisi şu anda kullanılamıyor.");
}

function settings() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const secret = process.env.KEY_HASH_SECRET;
  if (!url || !token || !secret || secret.length < 32) throw unavailable();
  let parsed;
  try { parsed = new URL(url); } catch { throw unavailable(); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw unavailable();
  }
  return { url: parsed.href.replace(/\/$/, ""), token, secret };
}

function isConfigured() {
  try { settings(); return true; } catch { return false; }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function privateHash(value, label) {
  return crypto.createHmac("sha256", settings().secret).update(`${label}:${value}`).digest("hex");
}

function ownerHash(sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) {
    throw new StoreError(400, "invalid_session", "Geçersiz oturum.");
  }
  return privateHash(sessionId, "session");
}

function timeWindow() {
  const now = Math.floor(Date.now() / 1000);
  return { now, day: Math.floor(now / 86400), minute: Math.floor(now / 60),
    dayRetry: 86400 - (now % 86400), minuteRetry: 60 - (now % 60) };
}

async function evaluate(script, keys, args) {
  const config = settings();
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args.map(String)]),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw unavailable();
    const result = await response.json();
    if (!result || Object.hasOwn(result, "error") || !Array.isArray(result.result)) throw unavailable();
    return result.result;
  } catch { throw unavailable(); }
}

// Every decision and mutation is inside one server-side script. Quotas belong to
// the anonymous owner, so rotating a key does not reset either counter.
const RESERVE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0,401,'invalid_api_key',0} end
local key = cjson.decode(raw)
local now = tonumber(ARGV[1])
if tonumber(key.expires_at) <= now then return {0,401,'expired_api_key',0} end
local ownerKey = 'kly:owner:' .. key.ownerHash
if redis.call('GET', ownerKey) ~= ARGV[7] then return {0,401,'invalid_api_key',0} end
local minuteKey = 'kly:minute:' .. key.ownerHash .. ':' .. ARGV[3]
local dayKey = 'kly:day:' .. key.ownerHash .. ':' .. ARGV[2]
local rate = tonumber(redis.call('GET', minuteKey) or '0')
local used = tonumber(redis.call('GET', dayKey) or '0')
if rate >= 5 then return {0,429,'rate_limited',tonumber(ARGV[4])} end
if ARGV[6] == '1' and used >= 50 then return {0,429,'daily_limit_exceeded',tonumber(ARGV[5])} end
redis.call('INCR', minuteKey)
redis.call('EXPIRE', minuteKey, 120)
if ARGV[6] == '1' then
  used = redis.call('INCR', dayKey)
  redis.call('EXPIRE', dayKey, 172800)
  redis.call('SET', KEYS[2], dayKey, 'EX', 600)
end
return {1,used,math.max(0,50-used)}
`;

const RELEASE = `
local dayKey = redis.call('GET', KEYS[1])
if not dayKey then return {0} end
redis.call('DEL', KEYS[1])
local used = tonumber(redis.call('GET', dayKey) or '0')
if used > 0 then redis.call('DECR', dayKey) end
return {1}
`;

const SESSION = `
local keyHash = redis.call('GET', KEYS[1])
if not keyHash then return {0} end
local raw = redis.call('GET', 'kly:key:' .. keyHash)
if not raw then redis.call('DEL', KEYS[1]); return {0} end
local key = cjson.decode(raw)
if tonumber(key.expires_at) <= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1]); return {0}
end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
return {1,raw,used}
`;

const CREATE = `
local active = redis.call('GET', KEYS[1])
if active then
  local previous = redis.call('GET', 'kly:key:' .. active)
  if previous and tonumber(cjson.decode(previous).expires_at) > tonumber(ARGV[1]) then
    return {0,409,'active_key_exists',0}
  end
end
local issued = tonumber(redis.call('GET', KEYS[3]) or '0')
if issued >= 3 then return {0,429,'creation_limit_exceeded',tonumber(ARGV[5])} end
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], 172800)
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
local used = tonumber(redis.call('GET', KEYS[4]) or '0')
return {1,ARGV[3],used}
`;

const REVOKE = `
local active = redis.call('GET', KEYS[1])
if active then redis.call('DEL', 'kly:key:' .. active) end
redis.call('DEL', KEYS[1])
return {1}
`;

const messages = {
  invalid_api_key: "API anahtarı geçersiz veya iptal edilmiş.",
  expired_api_key: "API anahtarının süresi dolmuş.",
  rate_limited: "Dakikalık 5 istek sınırına ulaştınız.",
  daily_limit_exceeded: "Günlük 50 istek sınırına ulaştınız.",
  active_key_exists: "Bu oturumda zaten etkin bir anahtar var.",
  creation_limit_exceeded: "Bu bağlantı için günlük anahtar oluşturma sınırına ulaşıldı.",
};

function rejection(result) {
  const status = Number(result[1]);
  const code = result[2];
  if (![401, 409, 429].includes(status) || !Object.hasOwn(messages, code)) throw unavailable();
  return { ok: false, status, code, message: messages[code],
    ...(Number(result[3]) > 0 ? { retryAfter: Number(result[3]) } : {}) };
}

function metadata(raw, used) {
  let key;
  try { key = JSON.parse(raw); } catch { throw unavailable(); }
  if (!key || typeof key.prefix !== "string" || !Number.isFinite(key.created_at)
    || !Number.isFinite(key.expires_at) || !Number.isSafeInteger(Number(used)) || Number(used) < 0) {
    throw unavailable();
  }
  return { prefix: key.prefix, created_at: new Date(key.created_at * 1000).toISOString(),
    expires_at: new Date(key.expires_at * 1000).toISOString(), daily_limit: DAILY_LIMIT,
    used_today: Number(used), remaining_today: Math.max(0, DAILY_LIMIT - Number(used)) };
}

async function reserve(token, { consumeDaily = true } = {}) {
  settings();
  if (typeof token !== "string" || !/^kly_[A-Za-z0-9_-]{43}$/.test(token)) {
    return rejection([0, 401, "invalid_api_key", 0]);
  }
  const time = timeWindow();
  const digest = hashToken(token);
  const id = crypto.randomBytes(16).toString("hex");
  const result = await evaluate(RESERVE, [`${PREFIX}key:${digest}`, `${PREFIX}reservation:${id}`],
    [time.now, time.day, time.minute, time.minuteRetry, time.dayRetry, consumeDaily ? 1 : 0, digest]);
  if (result[0] === 0) return rejection(result);
  if (result[0] !== 1 || !Number.isSafeInteger(result[1]) || result[1] < 0
    || !Number.isSafeInteger(result[2]) || result[2] < 0
    || result[2] !== Math.max(0, DAILY_LIMIT - result[1])) throw unavailable();
  return { ok: true, reservation: consumeDaily ? { id } : null,
    usedToday: result[1], remainingToday: result[2] };
}

async function release(reservation) {
  if (!reservation) return;
  if (typeof reservation.id !== "string" || !/^[a-f0-9]{32}$/.test(reservation.id)) throw unavailable();
  const result = await evaluate(RELEASE, [`${PREFIX}reservation:${reservation.id}`], []);
  if (![0, 1].includes(result[0])) throw unavailable();
}

async function getSession(sessionId) {
  const owner = ownerHash(sessionId);
  const time = timeWindow();
  const result = await evaluate(SESSION, [`${PREFIX}owner:${owner}`, `${PREFIX}day:${owner}:${time.day}`], [time.now]);
  if (result[0] === 0) return null;
  if (result[0] !== 1) throw unavailable();
  return metadata(result[1], result[2]);
}

async function createKey(sessionId, ip) {
  const owner = ownerHash(sessionId);
  const time = timeWindow();
  const token = `kly_${crypto.randomBytes(32).toString("base64url")}`;
  const digest = hashToken(token);
  const record = JSON.stringify({ prefix: token.slice(0, 12), created_at: time.now,
    expires_at: time.now + KEY_LIFETIME, ownerHash: owner });
  const ipHash = privateHash(String(ip || "unknown"), "ip");
  const result = await evaluate(CREATE, [`${PREFIX}owner:${owner}`, `${PREFIX}key:${digest}`,
    `${PREFIX}issue:${ipHash}:${time.day}`, `${PREFIX}day:${owner}:${time.day}`],
  [time.now, digest, record, KEY_LIFETIME, time.dayRetry]);
  if (result[0] === 0) {
    const denied = rejection(result);
    throw new StoreError(denied.status, denied.code, denied.message, denied.retryAfter);
  }
  if (result[0] !== 1) throw unavailable();
  return { api_key: token, key: metadata(result[1], result[2]) };
}

async function revokeKey(sessionId) {
  const owner = ownerHash(sessionId);
  const result = await evaluate(REVOKE, [`${PREFIX}owner:${owner}`], []);
  if (result[0] !== 1) throw unavailable();
}

module.exports = { isConfigured, hashToken, reserve, release, getSession, createKey, revokeKey,
  serviceInfo, limits: Object.freeze({ daily_requests: DAILY_LIMIT, requests_per_minute: MINUTE_LIMIT }) };

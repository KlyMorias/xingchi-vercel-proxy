const crypto = require("node:crypto");
const stateStore = require("./state-store.js");
const { serviceInfo } = require("./models.js");
const { normalizeTokenUsage } = require("./token-usage");
const { HOLD_SECONDS, TICKET_SECONDS, RECEIPT_SECONDS, unresolved, holdExpiry,
  activeHold, markUnknownInState } = require("./usage-accounting");

const KEY_LIFETIME = 30 * 86400;
const limits = Object.freeze({ daily_tokens: 1_000_000_000, requests_per_minute: 5 });

function error(status, code, message, retryAfter) {
  return Object.assign(new Error(message), { status, statusCode: status, code,
    ...(retryAfter ? { retryAfter } : {}) });
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function nowWindow(now = Math.floor(Date.now() / 1000)) {
  const day = Math.floor(now / 86400);
  const weekday = (day + 3) % 7; // Unix epoch starts on Thursday; UTC week starts Monday.
  return { now, day, hour: Math.floor(now / 3600), week: Math.floor((day + 3) / 7), minute: Math.floor(now / 60),
    hourRetry: 3600 - now % 3600, dayRetry: 86400 - now % 86400,
    weekRetry: ((weekday === 0 ? 7 : 7 - weekday) * 86400) - now % 86400,
    minuteRetry: 60 - now % 60 };
}
function findUser(state, userId) {
  return Object.values(state.users).find((user) => user.id === userId);
}
function requireUser(state, userId) {
  const user = findUser(state, typeof userId === "object" ? userId?.id : userId);
  if (!user || user.enabled !== true) throw error(401, "account_unavailable", "Hesabınız kullanıma kapalı veya oturum geçersiz.");
  return user;
}
function userLimits(user) {
  const minute = user.requests_per_minute ?? limits.requests_per_minute;
  if (!Number.isSafeInteger(minute) || minute < 1) {
    throw error(503, "storage_unavailable", "Hesap sınırları okunamıyor.");
  }
  // The free plan applies to every account, including existing accounts whose
  // stored request-count limits predate token metering. No data rewrite is needed.
  return { daily_tokens: limits.daily_tokens, requests_per_minute: minute };
}
function usageFor(state, userId, time) {
  let usage = state.usage[userId];
  if (!usage || typeof usage !== "object") usage = {};
  const current = { hour: time.hour, used_this_hour: usage.hour === time.hour ? usage.used_this_hour || 0 : 0,
    day: time.day, used_today: usage.day === time.day ? usage.used_today || 0 : 0,
    week: time.week, used_this_week: usage.week === time.week ? usage.used_this_week || 0 : 0,
    minute: time.minute, used_minute: usage.minute === time.minute ? usage.used_minute || 0 : 0,
    input_tokens_today: usage.day === time.day ? usage.input_tokens_today ?? 0 : 0,
    output_tokens_today: usage.day === time.day ? usage.output_tokens_today ?? 0 : 0,
    unknown_requests_today: usage.day === time.day ? usage.unknown_requests_today ?? 0 : 0,
    legacy_usage_unknown: usage.day === time.day && (usage.legacy_usage_unknown === true
      || (usage.used_today > 0 && (usage.input_tokens_today === undefined || usage.output_tokens_today === undefined))),
    last_settlement: settlementMetadata(usage.last_settlement) };
  if (![current.used_this_hour, current.used_today, current.used_this_week, current.used_minute,
    current.input_tokens_today, current.output_tokens_today, current.unknown_requests_today]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw error(503, "storage_unavailable", "Kullanım bilgileri okunamıyor.");
  }
  current.total_tokens_today = current.input_tokens_today + current.output_tokens_today;
  // Derive holds from live tickets rather than a separate mutable counter.
  // Expired tickets removed by storage cleanup cannot leave a stuck balance.
  current.reserved_tokens_today = Object.values(state.reservations || {})
    .filter((saved) => saved.user_id === userId && saved.day === time.day && activeHold(saved, time.now))
    .reduce((total, saved) => {
      if (!Number.isSafeInteger(saved.tokens) || saved.tokens < 1) throw error(503, "storage_unavailable", "Kullanım bilgileri okunamıyor.");
      return total + saved.tokens;
    }, 0);
  if (![current.total_tokens_today, current.reserved_tokens_today].every(Number.isSafeInteger)) {
    throw error(503, "storage_unavailable", "Kullanım bilgileri okunamıyor.");
  }
  // A read must be honest even if no mutation has persisted expired tickets yet.
  current.expired_unknown_requests_today = Object.values(state.reservations || {})
    .filter((saved) => saved.user_id === userId && saved.day === time.day && unresolved(saved)
      && saved.status !== "unknown" && holdExpiry(saved) <= time.now).length;
  return current;
}
function saveUsage(state, userId, usage) {
  const { expired_unknown_requests_today, ...saved } = usage;
  state.usage[userId] = saved;
}
function settlementMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const identifier = (text) => typeof text === "string" && /^[A-Za-z0-9_.:\/-]{1,160}$/.test(text) ? text : null;
  try {
    const tokens = normalizeTokenUsage(value);
    const recorded = Date.parse(value.recorded_at);
    if (!Number.isFinite(recorded)) return null;
    return { recorded_at: new Date(recorded).toISOString(), response_id: identifier(value.response_id),
      model: identifier(value.model), ...tokens };
  } catch { return null; }
}
function accountingSummary(usage) {
  const unknown = usage.unknown_requests_today + usage.expired_unknown_requests_today;
  if (!Number.isSafeInteger(unknown)) throw error(503, "storage_unavailable", "Kullanım bilgileri okunamıyor.");
  return { source: "provider_usage", status: unknown > 0 || usage.legacy_usage_unknown ? "partial" : "complete",
    quota_scope: "application_daily", provider_balance: null, provider_balance_status: "not_exposed",
    reserved_kind: "admission_estimate", unknown_requests_today: unknown,
    legacy_usage_unknown: usage.legacy_usage_unknown, last_settlement: usage.last_settlement };
}
function activeEntry(state, userId, now) {
  return Object.entries(state.keys).find(([, key]) => key.user_id === userId && !key.revoked_at && key.expires_at > now);
}
function metadata(key, user, usage) {
  const cap = userLimits(user);
  return { prefix: key.prefix, created_at: new Date(key.created_at * 1000).toISOString(),
    expires_at: new Date(key.expires_at * 1000).toISOString(), daily_tokens: cap.daily_tokens,
    requests_per_minute: cap.requests_per_minute, used_today: usage.used_today,
    used_this_hour: usage.used_this_hour, used_this_week: usage.used_this_week,
    ...tokenSummary(usage, cap) };
}
function tokenSummary(usage, cap) {
  return { input_tokens_today: usage.input_tokens_today, output_tokens_today: usage.output_tokens_today,
    total_tokens_today: usage.total_tokens_today, reserved_tokens_today: usage.reserved_tokens_today,
    remaining_tokens_today: Math.max(0, cap.daily_tokens - usage.total_tokens_today - usage.reserved_tokens_today) };
}
function deny(status, code, message, retryAfter) {
  return { ok: false, status, code, message, ...(retryAfter ? { retryAfter } : {}) };
}

// Reuse one authoritative snapshot for authentication and dashboard data instead
// of re-reading storage for the same account several times during initial load.
function accountInfoFromState(state, userId, now = Math.floor(Date.now() / 1000)) {
  const user = requireUser(state, userId);
  const time = nowWindow(now);
  const usage = usageFor(state, user.id, time);
  const entry = activeEntry(state, user.id, time.now);
  const cap = userLimits(user);
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  return { key: entry ? metadata(entry[1], user, usage) : null, limits: cap,
    usage: { used_this_hour: usage.used_this_hour, used_today: usage.used_today, used_this_week: usage.used_this_week,
      ...tokenSummary(usage, cap), accounting: accountingSummary(usage),
      hour_resets_at: iso(time.now + time.hourRetry), day_resets_at: iso(time.now + time.dayRetry),
      week_resets_at: iso(time.now + time.weekRetry), server_time: iso(time.now) } };
}

function createKeyStore(storage = stateStore, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  async function getSession(userId) {
    const state = await storage.readState();
    const user = requireUser(state, userId);
    const time = nowWindow(now());
    const entry = activeEntry(state, user.id, time.now);
    return entry ? metadata(entry[1], user, usageFor(state, user.id, time)) : null;
  }
  async function getAccountInfo(userId) {
    return accountInfoFromState(await storage.readState(), userId, now());
  }
  async function createKey(userId) {
    const token = `kly_${crypto.randomBytes(32).toString("base64url")}`;
    const digest = hashToken(token);
    return storage.mutateState((state) => {
      const user = requireUser(state, userId);
      const time = nowWindow(now());
      if (activeEntry(state, user.id, time.now)) throw error(409, "active_key_exists", "Hesabınızda zaten etkin bir API anahtarı var.");
      const key = { user_id: user.id, prefix: token.slice(0, 12), created_at: time.now, expires_at: time.now + KEY_LIFETIME };
      state.keys[digest] = key;
      return { api_key: token, ...accountInfoFromState(state, user.id, time.now) };
    });
  }
  async function revokeKey(userId) {
    await storage.mutateState((state) => {
      const user = requireUser(state, userId);
      for (const [digest, key] of Object.entries(state.keys)) {
        if (key.user_id === user.id) delete state.keys[digest];
      }
    });
  }
  // The standalone large-body ingress checks the key before allocating or
  // decoding an upload. This read-only check is deliberately not a quota ticket:
  // reserve() must still revalidate the current key and account after parsing.
  async function authenticate(token) {
    if (typeof token !== "string" || !/^kly_[A-Za-z0-9_-]{43}$/.test(token)) {
      return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
    }
    const state = await storage.readState();
    const key = state.keys[hashToken(token)];
    if (!key || key.revoked_at || !Number.isSafeInteger(key.expires_at) || key.expires_at <= now()) {
      return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
    }
    const user = findUser(state, key.user_id);
    if (!user || user.enabled !== true) {
      return deny(401, "account_disabled", "Bu API anahtarının bağlı olduğu hesap kullanıma kapalı.");
    }
    return { ok: true };
  }
  async function reserve(token, { consumeDaily = true, estimatedTokens = 1 } = {}) {
    if (typeof token !== "string" || !/^kly_[A-Za-z0-9_-]{43}$/.test(token)) {
      return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
    }
    const digest = hashToken(token);
    const id = crypto.randomBytes(16).toString("hex");
    if (consumeDaily && (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1)) {
      throw error(400, "invalid_token_reservation", "Token rezervasyonu pozitif tam sayı olmalı.");
    }
    return storage.mutateState((state) => {
      const key = state.keys[digest];
      const time = nowWindow(now());
      if (!key || key.revoked_at || key.expires_at <= time.now) return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
      const user = findUser(state, key.user_id);
      if (!user || user.enabled !== true) return deny(401, "account_disabled", "Bu API anahtarının bağlı olduğu hesap kullanıma kapalı.");
      const cap = userLimits(user);
      const usage = usageFor(state, user.id, time);
      if (usage.used_minute >= cap.requests_per_minute) {
        return deny(429, "rate_limited", `Dakikalık ${cap.requests_per_minute} istek sınırına ulaştınız.`, time.minuteRetry);
      }
      if (consumeDaily && estimatedTokens > cap.daily_tokens - usage.total_tokens_today - usage.reserved_tokens_today) {
        return deny(429, "daily_token_limit_exceeded", "Günlük ücretsiz 1 milyar token kotasında bu istek için yeterli token kalmadı.", time.dayRetry);
      }
      usage.used_minute++;
      if (consumeDaily) {
        usage.used_this_hour++;
        usage.used_today++;
        usage.used_this_week++;
        state.reservations[id] = { kind: "tokens", tokens: estimatedTokens, user_id: user.id,
          hour: time.hour, day: time.day, week: time.week, hold_expires_at: time.now + HOLD_SECONDS,
          expires_at: time.now + TICKET_SECONDS };
        usage.reserved_tokens_today += estimatedTokens;
      }
      saveUsage(state, user.id, usage);
      return { ok: true, reservation: consumeDaily ? { id } : null, usedToday: usage.used_today,
        ...tokenSummary(usage, cap) };
    });
  }
  async function settle(reservation, tokenUsage, details = {}) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım kaydedilemedi.");
    const tokens = normalizeTokenUsage(tokenUsage);
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved) throw error(503, "invalid_reservation", "Kullanım kaydedilemedi.");
      if (saved.kind !== "tokens") throw error(503, "invalid_reservation", "Kullanım kaydedilemedi.");
      if (saved.status === "settled") {
        if (saved.settlement.input_tokens !== tokens.input_tokens || saved.settlement.output_tokens !== tokens.output_tokens) {
          throw error(502, "conflicting_token_usage", "Sağlayıcı token kullanımı önceki kayıtla tutarsız.");
        }
        return;
      }
      const time = nowWindow(now());
      const usage = usageFor(state, saved.user_id, time);
      if (saved.day === time.day) {
        if (saved.status === "unknown") usage.unknown_requests_today = Math.max(0, usage.unknown_requests_today - 1);
        usage.input_tokens_today += tokens.input_tokens;
        usage.output_tokens_today += tokens.output_tokens;
        usage.total_tokens_today = usage.input_tokens_today + usage.output_tokens_today;
        if (![usage.input_tokens_today, usage.output_tokens_today, usage.total_tokens_today].every(Number.isSafeInteger)) {
          throw error(503, "storage_unavailable", "Kullanım kaydedilemedi.");
        }
      }
      const receipt = settlementMetadata({ ...details, ...tokens, recorded_at: new Date(time.now * 1000).toISOString() });
      saved.status = "settled";
      saved.settlement = { input_tokens: tokens.input_tokens, output_tokens: tokens.output_tokens };
      saved.expires_at = time.now + RECEIPT_SECONDS;
      usage.last_settlement = receipt;
      usage.reserved_tokens_today = usageFor(state, saved.user_id, time).reserved_tokens_today;
      saveUsage(state, saved.user_id, usage);
    });
  }
  async function markUnknown(reservation) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım kaydedilemedi.");
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved || saved.status === "settled") return;
      markUnknownInState(state, saved);
    });
  }
  async function release(reservation) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım iadesi yapılamadı.");
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved) return;
      if (saved.status === "settled") return;
      delete state.reservations[reservation.id];
      const usage = state.usage[saved.user_id];
      if (!usage) return;
      if (saved.status === "unknown" && usage.day === saved.day) {
        usage.unknown_requests_today = Math.max(0, (usage.unknown_requests_today ?? 0) - 1);
      }
      if (usage.hour === saved.hour && usage.used_this_hour > 0) usage.used_this_hour--;
      if (usage.day === saved.day && usage.used_today > 0) usage.used_today--;
      if (usage.week === saved.week && usage.used_this_week > 0) usage.used_this_week--;
      if (saved.kind === "tokens") usage.reserved_tokens_today = usageFor(state, saved.user_id, nowWindow(now())).reserved_tokens_today;
    });
  }
  return { isConfigured: storage.isConfigured, hashToken, authenticate, reserve, settle, markUnknown, release, getSession, getAccountInfo,
    createKey, revokeKey, serviceInfo, limits };
}

module.exports = { ...createKeyStore(), createKeyStore, serviceInfo, limits, hashToken, accountInfoFromState };

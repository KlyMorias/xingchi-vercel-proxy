const crypto = require("node:crypto");
const stateStore = require("./state-store.js");
const { serviceInfo } = require("./models.js");
const { normalizeTokenUsage } = require("./token-usage");
const { HOLD_SECONDS, TICKET_SECONDS, RECEIPT_SECONDS, unresolved, holdExpiry,
  activeHold, markUnknownInState } = require("./usage-accounting");
const { startRequest, finishRequest } = require("./request-history");

const KEY_LIFETIME = 30 * 86400;
const MAX_ACTIVE_KEYS = 10;
const KEY_ID = /^key_[a-f0-9]{32}$/;
const DEFAULT_KEY_NAME = "Kişisel anahtar";
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
  return activeEntries(state, userId, now)[0];
}
function activeEntries(state, userId, now) {
  return Object.entries(state.keys).filter(([, key]) => key.user_id === userId && !key.revoked_at
    && Number.isSafeInteger(key.expires_at) && key.expires_at > now);
}
function keyIdentifier(key, digest) {
  if (KEY_ID.test(key.id || "")) return key.id;
  // Existing credentials stay valid. Their stable public id is a one-way,
  // separately namespaced projection, never the stored token digest itself.
  return "key_" + crypto.createHash("sha256").update("klyapi-project-key-v1:" + key.user_id + ":" + digest).digest("hex").slice(0, 32);
}
function keyName(value = DEFAULT_KEY_NAME) {
  if (typeof value !== "string") throw error(400, "invalid_key_name", "Anahtar adı 1–48 harf, rakam, boşluk veya . _ ( ) - içermeli.");
  const name = value.normalize("NFC").trim().replace(/ {2,}/g, " ");
  if (!/^[\p{L}\p{M}\p{N} _().-]{1,48}$/u.test(name)
    || /(?:kly_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,})/.test(name)) {
    throw error(400, "invalid_key_name", "Anahtar adı 1–48 harf, rakam, boşluk veya . _ ( ) - içermeli.");
  }
  return name;
}
function storedKeyName(key) {
  try { return keyName(key.name); } catch { return DEFAULT_KEY_NAME; }
}
function keyUsageFor(state, key, time) {
  const saved = key.usage && typeof key.usage === "object" && !Array.isArray(key.usage) ? key.usage : {};
  const tracked = Number.isSafeInteger(saved.tracking_started_at) && saved.tracking_started_at >= 0 ? saved.tracking_started_at : null;
  const sameDay = saved.day === time.day;
  const current = { day: time.day, tracking_started_at: tracked,
    legacy_usage_unknown: tracked === null || saved.legacy_usage_unknown === true,
    used_today: sameDay ? saved.used_today ?? 0 : 0,
    input_tokens_today: sameDay ? saved.input_tokens_today ?? 0 : 0,
    output_tokens_today: sameDay ? saved.output_tokens_today ?? 0 : 0,
    unknown_requests_today: sameDay ? saved.unknown_requests_today ?? 0 : 0 };
  if (![current.used_today, current.input_tokens_today, current.output_tokens_today, current.unknown_requests_today]
    .every(value => Number.isSafeInteger(value) && value >= 0)) throw error(503, "storage_unavailable", "Anahtar kullanım bilgileri okunamıyor.");
  current.total_tokens_today = current.input_tokens_today + current.output_tokens_today;
  if (!Number.isSafeInteger(current.total_tokens_today)) throw error(503, "storage_unavailable", "Anahtar kullanım bilgileri okunamıyor.");
  current.expired_unknown_requests_today = Object.values(state.reservations || {})
    .filter(saved => saved.key_id === key.id && saved.user_id === key.user_id && saved.day === time.day && unresolved(saved)
      && saved.status !== "unknown" && holdExpiry(saved) <= time.now).length;
  return current;
}
function saveKeyUsage(key, usage) {
  const { expired_unknown_requests_today, total_tokens_today, ...saved } = usage;
  key.usage = saved;
}
function ensureKeyMetadata(state, key, digest, time) {
  key.id = keyIdentifier(key, digest);
  key.name = storedKeyName(key);
  const usage = keyUsageFor(state, key, time);
  if (usage.tracking_started_at === null) usage.tracking_started_at = time.now;
  saveKeyUsage(key, usage);
  return usage;
}
function reservationKey(state, saved) {
  return saved.key_id && Object.values(state.keys).find(key => key.user_id === saved.user_id && key.id === saved.key_id);
}
function isoTime(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function projectMetadata(state, digest, key, time) {
  const usage = keyUsageFor(state, key, time);
  const unknown = usage.unknown_requests_today + usage.expired_unknown_requests_today;
  if (!Number.isSafeInteger(unknown)) throw error(503, "storage_unavailable", "Anahtar kullanım bilgileri okunamıyor.");
  // Public counters are today-only. The untracked part of a legacy key's
  // first day must stay explicit, but it cannot taint later fully tracked UTC
  // days. Keep the historical gap separately rather than rewriting the past.
  const legacyToday = usage.legacy_usage_unknown && (usage.tracking_started_at === null
    || time.day <= Math.floor(usage.tracking_started_at / 86400));
  return { id: keyIdentifier(key, digest), name: storedKeyName(key), prefix: key.prefix,
    created_at: isoTime(key.created_at), expires_at: isoTime(key.expires_at), last_used_at: isoTime(key.last_used_at),
    status: "active", used_today: usage.used_today, input_tokens_today: usage.input_tokens_today,
    output_tokens_today: usage.output_tokens_today, total_tokens_today: usage.total_tokens_today,
    unknown_requests_today: unknown, accounting: { source: "provider_usage",
      status: legacyToday || unknown > 0 ? "partial" : "complete", scope: "key_since_tracking",
      tracking_started_at: isoTime(usage.tracking_started_at), legacy_usage_unknown: legacyToday,
      historical_usage_unknown: usage.legacy_usage_unknown } };
}
function metadata(key, user, usage, digest) {
  const cap = userLimits(user);
  return { id: keyIdentifier(key, digest), name: storedKeyName(key), prefix: key.prefix, created_at: new Date(key.created_at * 1000).toISOString(),
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
  return { key: entry ? metadata(entry[1], user, usage, entry[0]) : null,
    keys: activeEntries(state, user.id, time.now).map(([digest, key]) => projectMetadata(state, digest, key, time)),
    key_limits: { max_active_keys: MAX_ACTIVE_KEYS }, limits: cap,
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
    return entry ? metadata(entry[1], user, usageFor(state, user.id, time), entry[0]) : null;
  }
  async function getAccountInfo(userId) {
    return accountInfoFromState(await storage.readState(), userId, now());
  }
  async function createKey(userId, name) {
    const label = keyName(name);
    const token = `kly_${crypto.randomBytes(32).toString("base64url")}`;
    const digest = hashToken(token);
    const id = "key_" + crypto.randomBytes(16).toString("hex");
    return storage.mutateState((state) => {
      const user = requireUser(state, userId);
      const time = nowWindow(now());
      if (activeEntries(state, user.id, time.now).length >= MAX_ACTIVE_KEYS) throw error(409, "active_key_limit", "En fazla 10 etkin proje anahtarı oluşturabilirsiniz.");
      const key = { id, name: label, user_id: user.id, prefix: token.slice(0, 12), created_at: time.now, expires_at: time.now + KEY_LIFETIME,
        usage: { tracking_started_at: time.now, legacy_usage_unknown: false, day: time.day,
          used_today: 0, input_tokens_today: 0, output_tokens_today: 0, unknown_requests_today: 0 } };
      state.keys[digest] = key;
      return { api_key: token, ...accountInfoFromState(state, user.id, time.now),
        key: metadata(key, user, usageFor(state, user.id, time), digest) };
    });
  }
  function targetKey(state, userId, id, time, allowOmitted = false) {
    if (id === undefined && allowOmitted) {
      const entries = activeEntries(state, userId, time.now);
      if (entries.length > 1) throw error(409, "key_id_required", "Birden fazla anahtar var; iptal edilecek anahtarı seçin.");
      return entries[0];
    }
    if (typeof id !== "string" || !KEY_ID.test(id)) throw error(400, "invalid_key_id", "Geçerli bir anahtar kimliği gerekli.");
    const entry = Object.entries(state.keys).find(([digest, key]) => key.user_id === userId && keyIdentifier(key, digest) === id);
    if (!entry) throw error(404, "key_not_found", "Anahtar bulunamadı.");
    return entry;
  }
  async function revokeKey(userId, id) {
    await storage.mutateState((state) => {
      const user = requireUser(state, userId);
      const time = nowWindow(now());
      const entry = targetKey(state, user.id, id, time, true);
      if (!entry || entry[1].revoked_at) return;
      ensureKeyMetadata(state, entry[1], entry[0], time);
      // Keep only a row needed by an admitted request. Repeated create/revoke
      // actions without in-flight work must not accumulate useless credentials.
      if (Object.values(state.reservations).some(saved => saved.user_id === user.id
        && saved.key_id === entry[1].id && unresolved(saved))) entry[1].revoked_at = time.now;
      else delete state.keys[entry[0]];
    });
  }
  async function renameKey(userId, id, name) {
    const label = keyName(name);
    return storage.mutateState(state => {
      const user = requireUser(state, userId);
      const time = nowWindow(now());
      const [digest, key] = targetKey(state, user.id, id, time);
      if (key.revoked_at || key.expires_at <= time.now) throw error(404, "key_not_found", "Etkin anahtar bulunamadı.");
      ensureKeyMetadata(state, key, digest, time);
      key.name = label;
      return accountInfoFromState(state, user.id, time.now);
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
  async function reserve(token, { consumeDaily = true, estimatedTokens = 1, request = {} } = {}) {
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
      if (!key || key.revoked_at || !Number.isSafeInteger(key.expires_at) || key.expires_at <= time.now) return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
      const user = findUser(state, key.user_id);
      if (!user || user.enabled !== true) return deny(401, "account_disabled", "Bu API anahtarının bağlı olduğu hesap kullanıma kapalı.");
      const cap = userLimits(user);
      const usage = usageFor(state, user.id, time);
      const projectUsage = ensureKeyMetadata(state, key, digest, time);
      if (consumeDaily) startRequest(state, { id, user_id: user.id, key_id: key.id, key_name: key.name,
        model: request?.model, endpoint: request?.endpoint,
        started_at: request?.started_at ?? new Date(time.now * 1000).toISOString() });
      const admissionDenied = (code, message, retryAfter) => {
        if (consumeDaily) finishRequest(state, id, { status: "error", usage_status: "not_started", http_status: 429, error_code: code,
          completed_at: new Date(time.now * 1000).toISOString() });
        return deny(429, code, message, retryAfter);
      };
      if (usage.used_minute >= cap.requests_per_minute) {
        return admissionDenied("rate_limited", `Dakikalık ${cap.requests_per_minute} istek sınırına ulaştınız.`, time.minuteRetry);
      }
      if (consumeDaily && estimatedTokens > cap.daily_tokens - usage.total_tokens_today - usage.reserved_tokens_today) {
        return admissionDenied("daily_token_limit_exceeded", "Günlük ücretsiz 1 milyar token kotasında bu istek için yeterli token kalmadı.", time.dayRetry);
      }
      usage.used_minute++;
      key.last_used_at = time.now;
      if (consumeDaily) {
        usage.used_this_hour++;
        usage.used_today++;
        usage.used_this_week++;
        projectUsage.used_today++;
        if (!Number.isSafeInteger(projectUsage.used_today)) throw error(503, "storage_unavailable", "Anahtar kullanım bilgileri kaydedilemedi.");
        saveKeyUsage(key, projectUsage);
        state.reservations[id] = { kind: "tokens", tokens: estimatedTokens, user_id: user.id, key_id: key.id, key_name: key.name,
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
      const key = reservationKey(state, saved);
      if (key && saved.day === time.day) {
        const projectUsage = keyUsageFor(state, key, time);
        if (saved.status === "unknown") projectUsage.unknown_requests_today = Math.max(0, projectUsage.unknown_requests_today - 1);
        projectUsage.input_tokens_today += tokens.input_tokens;
        projectUsage.output_tokens_today += tokens.output_tokens;
        if (![projectUsage.input_tokens_today, projectUsage.output_tokens_today,
          projectUsage.input_tokens_today + projectUsage.output_tokens_today].every(Number.isSafeInteger)) {
          throw error(503, "storage_unavailable", "Anahtar kullanımı kaydedilemedi.");
        }
        saveKeyUsage(key, projectUsage);
      }
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
      finishRequest(state, reservation.id, { ...details.activity, ...tokens,
        status: details.activity?.status || "success", usage_status: "verified", response_id: details.response_id,
        completed_at: details.activity?.completed_at ?? new Date(time.now * 1000).toISOString() });
    });
  }
  async function markUnknown(reservation, details = {}) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım kaydedilemedi.");
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved || saved.status === "settled") return;
      markUnknownInState(state, saved);
      finishRequest(state, reservation.id, { ...details.activity, status: details.activity?.status || "unknown", usage_status: "unavailable",
        completed_at: details.activity?.completed_at ?? new Date(now() * 1000).toISOString() });
    });
  }
  async function release(reservation, details = {}) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım iadesi yapılamadı.");
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved) return;
      if (saved.status === "settled") return;
      const time = nowWindow(now());
      const key = reservationKey(state, saved);
      if (key && saved.day === time.day) {
        const projectUsage = keyUsageFor(state, key, time);
        if (saved.status === "unknown") projectUsage.unknown_requests_today = Math.max(0, projectUsage.unknown_requests_today - 1);
        if (projectUsage.used_today > 0) projectUsage.used_today--;
        saveKeyUsage(key, projectUsage);
      }
      finishRequest(state, reservation.id, { ...details.activity, status: details.activity?.status || "cancelled",
        usage_status: details.activity?.usage_status || "not_started",
        completed_at: details.activity?.completed_at ?? new Date(time.now * 1000).toISOString() });
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
    createKey, revokeKey, renameKey, serviceInfo, limits };
}

module.exports = { ...createKeyStore(), createKeyStore, serviceInfo, limits, hashToken, accountInfoFromState };

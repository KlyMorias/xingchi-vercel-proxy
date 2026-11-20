const crypto = require("node:crypto");
const stateStore = require("./state-store.js");

const KEY_LIFETIME = 30 * 86400;
const limits = Object.freeze({ hourly_requests: 20, daily_requests: 50, weekly_requests: 200, requests_per_minute: 5 });
const serviceInfo = Object.freeze({ model: "gpt-6.1-sol", generation_available: true,
  message: "gpt-6.1-sol erişimi açık. OpenAI veya Anthropic uyumlu uygulamanı bağlayabilirsin." });

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
  const hourly = user.hourly_limit ?? limits.hourly_requests;
  const daily = user.daily_limit ?? limits.daily_requests;
  const weekly = user.weekly_limit ?? limits.weekly_requests;
  const minute = user.requests_per_minute ?? limits.requests_per_minute;
  if (![hourly, daily, weekly].every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(minute) || minute < 1) {
    throw error(503, "storage_unavailable", "Hesap sınırları okunamıyor.");
  }
  return { hourly_limit: hourly, daily_limit: daily, weekly_limit: weekly,
    hourly_requests: hourly, daily_requests: daily, weekly_requests: weekly, requests_per_minute: minute };
}
function usageFor(state, userId, time) {
  let usage = state.usage[userId];
  if (!usage || typeof usage !== "object") usage = {};
  const current = { hour: time.hour, used_this_hour: usage.hour === time.hour ? usage.used_this_hour || 0 : 0,
    day: time.day, used_today: usage.day === time.day ? usage.used_today || 0 : 0,
    week: time.week, used_this_week: usage.week === time.week ? usage.used_this_week || 0 : 0,
    minute: time.minute, used_minute: usage.minute === time.minute ? usage.used_minute || 0 : 0 };
  if (![current.used_this_hour, current.used_today, current.used_this_week, current.used_minute]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw error(503, "storage_unavailable", "Kullanım bilgileri okunamıyor.");
  }
  return current;
}
function activeEntry(state, userId, now) {
  return Object.entries(state.keys).find(([, key]) => key.user_id === userId && !key.revoked_at && key.expires_at > now);
}
function metadata(key, user, usage) {
  const cap = userLimits(user);
  return { prefix: key.prefix, created_at: new Date(key.created_at * 1000).toISOString(),
    expires_at: new Date(key.expires_at * 1000).toISOString(), hourly_limit: cap.hourly_requests,
    daily_limit: cap.daily_requests, weekly_limit: cap.weekly_requests,
    requests_per_minute: cap.requests_per_minute, used_today: usage.used_today,
    remaining_today: Math.max(0, cap.daily_requests - usage.used_today),
    used_this_hour: usage.used_this_hour, remaining_this_hour: Math.max(0, cap.hourly_requests - usage.used_this_hour),
    used_this_week: usage.used_this_week, remaining_this_week: Math.max(0, cap.weekly_requests - usage.used_this_week) };
}
function deny(status, code, message, retryAfter) {
  return { ok: false, status, code, message, ...(retryAfter ? { retryAfter } : {}) };
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
    const state = await storage.readState();
    const user = requireUser(state, userId);
    const time = nowWindow(now());
    const usage = usageFor(state, user.id, time);
    const entry = activeEntry(state, user.id, time.now);
    const cap = userLimits(user);
    return { key: entry ? metadata(entry[1], user, usage) : null, limits: cap,
      usage: { used_this_hour: usage.used_this_hour, remaining_this_hour: Math.max(0, cap.hourly_requests - usage.used_this_hour),
        used_today: usage.used_today, remaining_today: Math.max(0, cap.daily_requests - usage.used_today),
        used_this_week: usage.used_this_week, remaining_this_week: Math.max(0, cap.weekly_requests - usage.used_this_week) } };
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
      return { api_key: token, key: metadata(key, user, usageFor(state, user.id, time)) };
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
  async function reserve(token, { consumeDaily = true } = {}) {
    if (typeof token !== "string" || !/^kly_[A-Za-z0-9_-]{43}$/.test(token)) {
      return deny(401, "invalid_api_key", "API anahtarı geçersiz veya iptal edilmiş.");
    }
    const digest = hashToken(token);
    const id = crypto.randomBytes(16).toString("hex");
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
      if (consumeDaily && usage.used_this_hour >= cap.hourly_requests) {
        return deny(429, "hourly_limit_exceeded", `Saatlik ${cap.hourly_requests} istek sınırına ulaştınız.`, time.hourRetry);
      }
      if (consumeDaily && usage.used_today >= cap.daily_requests) {
        return deny(429, "daily_limit_exceeded", `Günlük ${cap.daily_requests} istek sınırına ulaştınız.`, time.dayRetry);
      }
      if (consumeDaily && usage.used_this_week >= cap.weekly_requests) {
        return deny(429, "weekly_limit_exceeded", `Haftalık ${cap.weekly_requests} istek sınırına ulaştınız.`, time.weekRetry);
      }
      usage.used_minute++;
      if (consumeDaily) {
        usage.used_this_hour++;
        usage.used_today++;
        usage.used_this_week++;
        state.reservations[id] = { user_id: user.id, hour: time.hour, day: time.day, week: time.week, expires_at: time.now + 600 };
      }
      state.usage[user.id] = usage;
      return { ok: true, reservation: consumeDaily ? { id } : null, usedToday: usage.used_today,
        remainingToday: Math.max(0, cap.daily_requests - usage.used_today), usedThisHour: usage.used_this_hour,
        remainingThisHour: Math.max(0, cap.hourly_requests - usage.used_this_hour),
        usedThisWeek: usage.used_this_week, remainingThisWeek: Math.max(0, cap.weekly_requests - usage.used_this_week) };
    });
  }
  async function release(reservation) {
    if (!reservation) return;
    if (!/^[a-f0-9]{32}$/.test(reservation.id || "")) throw error(503, "invalid_reservation", "Kullanım iadesi yapılamadı.");
    await storage.mutateState((state) => {
      const saved = state.reservations[reservation.id];
      if (!saved) return;
      delete state.reservations[reservation.id];
      const usage = state.usage[saved.user_id];
      if (!usage) return;
      if (usage.hour === saved.hour && usage.used_this_hour > 0) usage.used_this_hour--;
      if (usage.day === saved.day && usage.used_today > 0) usage.used_today--;
      if (usage.week === saved.week && usage.used_this_week > 0) usage.used_this_week--;
    });
  }
  return { isConfigured: storage.isConfigured, hashToken, reserve, release, getSession, getAccountInfo,
    createKey, revokeKey, serviceInfo, limits };
}

module.exports = { ...createKeyStore(), createKeyStore, serviceInfo, limits, hashToken };

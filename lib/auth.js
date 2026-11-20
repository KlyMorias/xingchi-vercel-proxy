const crypto = require("node:crypto");
const { promisify } = require("node:util");
const stateStore = require("./state-store");
const { error, clientIp, assertFields } = require("./http");
const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 7 * 86400;
const LOGIN_SECONDS = 15 * 60;
const USER_LIMIT = 100;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

function passwordValid(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

async function hashPassword(password) {
  if (!passwordValid(password)) throw error(400, "invalid_password", "Parola 8–128 karakter olmalı.");
  const salt = crypto.randomBytes(16).toString("hex");
  // Salt is deliberately the ASCII hex string, matching the bootstrap format.
  const hash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const match = typeof encoded === "string" ? encoded.match(HASH_PATTERN) : null;
  const candidate = typeof password === "string" && password.length <= 128 ? password : "invalid-password";
  const actual = await scrypt(candidate, match ? match[1] : "0".repeat(32), 64, SCRYPT_OPTIONS);
  const expected = match ? Buffer.from(match[2], "hex") : Buffer.alloc(64);
  return Boolean(match && typeof password === "string" && password.length <= 128 && crypto.timingSafeEqual(actual, expected));
}

function usernameKey(username) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_]{3,32}$/.test(username)
    || ["__proto__", "constructor", "prototype"].includes(username.toLowerCase())) {
    throw error(400, "invalid_username", "Kullanıcı adı 3–32 harf, rakam veya alt çizgi içermeli.");
  }
  return username.toLowerCase();
}

function publicUser(user) {
  return { username: user.username, role: user.role, enabled: user.enabled,
    daily_limit: user.daily_limit, requests_per_minute: user.requests_per_minute, created_at: user.created_at };
}

function sessionToken(req) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== "string") return null;
  return cookie.match(/(?:^|;\s*)kly_auth=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1] || null;
}

function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function has(object, key) { return Object.hasOwn(object, key); }
function findUser(state, id) { return Object.values(state.users).find((user) => user.id === id); }
function unauthorized() { return error(401, "unauthorized", "Oturum açmanız gerekiyor."); }

function sessionUser(state, token) {
  if (!token) throw unauthorized();
  const hash = tokenHash(token);
  const session = has(state.sessions, hash) ? state.sessions[hash] : null;
  const user = session && findUser(state, session.user_id);
  if (!session || session.expires_at <= Math.floor(Date.now() / 1000) || !user || !user.enabled
    || session.version !== user.session_version) throw unauthorized();
  return user;
}

function setSessionCookie(res, token) {
  res.setHeader("set-cookie", `kly_auth=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
}
function clearSessionCookie(res) {
  res.setHeader("set-cookie", "kly_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
}

function purgeSessions(state, userId) {
  for (const [hash, session] of Object.entries(state.sessions)) {
    if (session.user_id === userId) delete state.sessions[hash];
  }
}

function addSession(state, user, hash, now) {
  for (const [id, session] of Object.entries(state.sessions)) {
    if (session.expires_at <= now) delete state.sessions[id];
  }
  const existing = Object.entries(state.sessions).filter(([, session]) => session.user_id === user.id)
    .sort((a, b) => a[1].expires_at - b[1].expires_at);
  while (existing.length >= 10) delete state.sessions[existing.shift()[0]];
  state.sessions[hash] = { user_id: user.id, version: user.session_version, expires_at: now + SESSION_SECONDS };
}

function validateLimit(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw error(400, "invalid_limit", `${label} 1–${maximum} arasında bir tam sayı olmalı.`);
  }
  return value;
}

function createAuth({ readState, mutateState } = stateStore) {
  async function requireUser(req) {
    const user = sessionUser(await readState(), sessionToken(req));
    const { password_hash, ...safe } = user;
    return safe;
  }

  async function reserveLogin(req, username) {
    const secret = process.env.KEY_HASH_SECRET;
    if (!secret || secret.length < 32) throw error(503, "storage_unavailable", "Hesap servisine ulaşılamıyor.");
    const now = Math.floor(Date.now() / 1000);
    const ip = clientIp(req);
    const hash = (label, value) => crypto.createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");
    const ipKey = hash("login-ip", ip);
    const pairKey = hash("login-user-ip", `${ip}:${username}`);
    const result = await mutateState((state) => {
      for (const [key, counter] of Object.entries(state.login_attempts)) {
        if (counter.expires_at <= now) delete state.login_attempts[key];
      }
      for (const key of [ipKey, pairKey]) {
        const counter = has(state.login_attempts, key) ? state.login_attempts[key] : null;
        if (counter && counter.count >= 10) return { retryAfter: Math.max(1, counter.expires_at - now) };
      }
      for (const key of [ipKey, pairKey]) {
        const counter = has(state.login_attempts, key) ? state.login_attempts[key] : null;
        state.login_attempts[key] = { count: (counter?.count || 0) + 1,
          expires_at: counter?.expires_at || now + LOGIN_SECONDS };
      }
      return { ok: true };
    });
    if (!result.ok) throw error(429, "login_rate_limited", "Çok fazla giriş denemesi. Biraz sonra tekrar deneyin.", result.retryAfter);
  }

  async function login(req, res, body) {
    assertFields(body, ["action", "username", "password"]);
    const username = typeof body.username === "string" ? body.username.slice(0, 128).toLowerCase() : "";
    await reserveLogin(req, username);
    const state = await readState();
    const validName = /^[A-Za-z0-9_]{3,32}$/.test(username)
      && !["__proto__", "constructor", "prototype"].includes(username);
    const found = validName && has(state.users, username) ? state.users[username] : null;
    const verified = await verifyPassword(body.password, found?.password_hash);
    const rejected = () => error(401, "invalid_credentials", "Kullanıcı adı veya parola hatalı.");
    if (!verified || !found?.enabled) throw rejected();
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const now = Math.floor(Date.now() / 1000);
    const result = await mutateState((draft) => {
      const user = has(draft.users, username) ? draft.users[username] : null;
      if (!user?.enabled || user.password_hash !== found.password_hash || user.session_version !== found.session_version) throw rejected();
      addSession(draft, user, hash, now);
      return publicUser(user);
    });
    setSessionCookie(res, token);
    return result;
  }

  async function logout(req, res) {
    const token = sessionToken(req);
    if (token) await mutateState((state) => { delete state.sessions[tokenHash(token)]; });
    clearSessionCookie(res);
  }

  async function changePassword(req, res, body) {
    assertFields(body, ["action", "current_password", "new_password"]);
    const token = sessionToken(req);
    const state = await readState();
    const found = sessionUser(state, token);
    if (!(await verifyPassword(body.current_password, found.password_hash))) {
      throw error(401, "invalid_credentials", "Mevcut parola hatalı.");
    }
    const passwordHash = await hashPassword(body.new_password);
    const newToken = crypto.randomBytes(32).toString("base64url");
    const hash = tokenHash(newToken);
    const now = Math.floor(Date.now() / 1000);
    const changed = await mutateState((draft) => {
      const current = sessionUser(draft, token);
      if (current.password_hash !== found.password_hash || current.session_version !== found.session_version) throw unauthorized();
      current.password_hash = passwordHash;
      current.session_version++;
      purgeSessions(draft, current.id);
      addSession(draft, current, hash, now);
      return publicUser(current);
    });
    setSessionCookie(res, newToken);
    return changed;
  }

  function adminUser(state, req) {
    const user = sessionUser(state, sessionToken(req));
    if (user.role !== "admin") throw error(403, "admin_required", "Bu işlem için yönetici yetkisi gerekiyor.");
    return user;
  }

  async function listUsers(req) {
    const state = await readState();
    adminUser(state, req);
    return Object.values(state.users).map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
  }

  async function createUser(req, body) {
    assertFields(body, ["username", "password", "daily_limit", "requests_per_minute"]);
    const key = usernameKey(body.username);
    const daily = validateLimit(body.daily_limit, 50, 100000, "Günlük kota");
    const minute = validateLimit(body.requests_per_minute, 5, 1000, "Dakikalık kota");
    adminUser(await readState(), req);
    const passwordHash = await hashPassword(body.password);
    const id = crypto.randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    return await mutateState((state) => {
      adminUser(state, req);
      if (has(state.users, key)) throw error(409, "username_exists", "Bu kullanıcı adı zaten kullanılıyor.");
      if (Object.keys(state.users).length >= USER_LIMIT) throw error(409, "user_limit_reached", "Kullanıcı sınırına ulaşıldı.");
      const user = { id, username: body.username, role: "user", enabled: true, password_hash: passwordHash,
        session_version: 1, daily_limit: daily, requests_per_minute: minute, created_at: createdAt };
      state.users[key] = user;
      return publicUser(user);
    });
  }

  async function updateUser(req, body) {
    assertFields(body, ["username", "password", "enabled", "daily_limit", "requests_per_minute"]);
    const key = usernameKey(body.username);
    const daily = validateLimit(body.daily_limit, undefined, 100000, "Günlük kota");
    const minute = validateLimit(body.requests_per_minute, undefined, 1000, "Dakikalık kota");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw error(400, "invalid_enabled", "enabled değeri boolean olmalı.");
    if (Object.keys(body).length < 2) throw error(400, "empty_update", "Güncellenecek alan gerekli.");
    const before = await readState();
    adminUser(before, req);
    const target = has(before.users, key) ? before.users[key] : null;
    if (!target) throw error(404, "user_not_found", "Kullanıcı bulunamadı.");
    if (target.role === "admin" && (body.enabled !== undefined || body.password !== undefined)) {
      throw error(403, "admin_protected", "Yönetici hesabı buradan kapatılamaz veya parolası sıfırlanamaz.");
    }
    const passwordHash = body.password === undefined ? undefined : await hashPassword(body.password);
    return await mutateState((state) => {
      adminUser(state, req);
      const user = has(state.users, key) ? state.users[key] : null;
      if (!user) throw error(404, "user_not_found", "Kullanıcı bulunamadı.");
      if (user.role === "admin" && (body.enabled !== undefined || passwordHash)) {
        throw error(403, "admin_protected", "Yönetici hesabı bu işlemden korunuyor.");
      }
      if (daily !== undefined) user.daily_limit = daily;
      if (minute !== undefined) user.requests_per_minute = minute;
      const invalidate = passwordHash !== undefined || (body.enabled !== undefined && body.enabled !== user.enabled);
      if (body.enabled !== undefined) user.enabled = body.enabled;
      if (passwordHash) user.password_hash = passwordHash;
      if (invalidate) { user.session_version++; purgeSessions(state, user.id); }
      return publicUser(user);
    });
  }

  return { requireUser, login, logout, changePassword, listUsers, createUser, updateUser };
}

module.exports = { ...createAuth(), createAuth, hashPassword, verifyPassword, publicUser, sessionToken };

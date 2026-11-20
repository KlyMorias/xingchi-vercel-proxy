const crypto = require("node:crypto");
const net = require("node:net");
const store = require("../lib/key-store.js");

const SESSION_LIFETIME = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function requestError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sessionFrom(req) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== "string") return null;
  const match = cookie.match(/(?:^|;\s*)kly_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match ? match[1] : null;
}

function newSession(res) {
  const id = crypto.randomBytes(32).toString("base64url");
  res.setHeader("set-cookie", `kly_session=${id}; Path=/; Max-Age=${SESSION_LIFETIME}; HttpOnly; Secure; SameSite=Strict`);
  return id;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.protocol === "https:" && parsed.host.toLowerCase() === host.toLowerCase()
      && req.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}

function clientIp(req) {
  const forwarded = req.headers["x-vercel-forwarded-for"];
  let ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket?.remoteAddress;
  if (typeof ip !== "string") return "unknown";
  if (ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : "unknown";
}

async function readBody(req, allowEmpty) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] || "")) {
    throw requestError(415, "invalid_content_type", "Content-Type application/json olmalı.");
  }
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw requestError(415, "unsupported_encoding", "Sıkıştırılmış istek desteklenmiyor.");
  }
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
    throw requestError(413, "body_too_large", "İstek gövdesi çok büyük.");
  }
  let text;
  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) throw requestError(413, "body_too_large", "İstek gövdesi çok büyük.");
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (text === undefined || text === "") {
    // Some runtimes have already buffered the stream. Access Vercel's parsed
    // body lazily as a fallback, without bypassing our own size/object checks.
    let body;
    try { body = req.body; } catch {
      throw requestError(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
    }
    text = Buffer.isBuffer(body) ? body.toString("utf8")
      : typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw requestError(413, "body_too_large", "İstek gövdesi çok büyük.");
  }
  if (!text && allowEmpty) return;
  let value;
  try { value = JSON.parse(text); } catch {
    throw requestError(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
  }
}

async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("vary", "Cookie, Origin");
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("allow", "GET, POST, DELETE");
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Yöntem desteklenmiyor." } });
    return;
  }
  if (req.method !== "GET" && !sameOrigin(req)) {
    sendJson(res, 403, { error: { code: "origin_not_allowed", message: "Bu kaynaktan işlem yapılamaz." } });
    return;
  }
  let session = sessionFrom(req);
  if (req.method === "GET" && !session) session = newSession(res);
  try {
    if (!store.isConfigured()) throw requestError(503, "storage_unavailable", "Anahtar servisi şu anda kullanılamıyor.");
    if (req.method !== "GET") await readBody(req, req.method === "DELETE");
    if (req.method === "POST") {
      if (!session) session = newSession(res);
      const created = await store.createKey(session, clientIp(req));
      sendJson(res, 201, { ...created, limits: store.limits, service: store.serviceInfo });
    } else if (req.method === "DELETE") {
      if (session) await store.revokeKey(session);
      res.statusCode = 204;
      res.end();
    } else {
      const key = await store.getSession(session);
      sendJson(res, 200, { key, limits: store.limits, service: store.serviceInfo });
    }
  } catch (error) {
    const status = [400, 409, 413, 415, 429, 503].includes(error.status) ? error.status : 503;
    if (error.retryAfter) res.setHeader("retry-after", String(error.retryAfter));
    sendJson(res, status, { error: { code: status === 503 ? "storage_unavailable" : error.code,
      message: status === 503 ? "Anahtar servisi şu anda kullanılamıyor." : error.message } });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };

const store = require("../lib/key-store.js");
const MAX_BODY_BYTES = 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function requestError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
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
  if (!text && allowEmpty) return {};
  let value;
  try { value = JSON.parse(text); } catch {
    throw requestError(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
  }
  return value;
}

function createHandler(keyStore = store, authProvider = null) {
return async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("vary", "Cookie, Origin");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("allow", "GET, POST, PATCH, DELETE");
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Yöntem desteklenmiyor." } });
    return;
  }
  if (req.method !== "GET" && !sameOrigin(req)) {
    sendJson(res, 403, { error: { code: "origin_not_allowed", message: "Bu kaynaktan işlem yapılamaz." } });
    return;
  }
  try {
    if (!keyStore.isConfigured()) throw requestError(503, "storage_unavailable", "Anahtar servisi şu anda kullanılamıyor.");
    const user = await (authProvider || require("../lib/auth.js")).requireUser(req);
    const body = req.method !== "GET" ? await readBody(req, req.method === "DELETE") : {};
    const allowed = req.method === "POST" ? ["name"] : req.method === "PATCH" ? ["id", "name"] : ["id"];
    if (Object.keys(body).some(field => !allowed.includes(field))) throw requestError(400, "invalid_fields", "Desteklenmeyen anahtar alanı.");
    if (req.method === "POST") {
      const created = await keyStore.createKey(user.id, body.name);
      sendJson(res, 201, { ...created,
        service: keyStore.serviceInfo });
    } else if (req.method === "PATCH") {
      if (!Object.hasOwn(body, "name")) throw requestError(400, "invalid_key_name", "Anahtar adı gerekli.");
      const info = await keyStore.renameKey(user.id, body.id, body.name);
      sendJson(res, 200, { ...info, service: keyStore.serviceInfo });
    } else if (req.method === "DELETE") {
      await keyStore.revokeKey(user.id, body.id);
      res.statusCode = 204;
      res.end();
    } else {
      const info = await keyStore.getAccountInfo(user.id);
      sendJson(res, 200, { ...info, service: keyStore.serviceInfo });
    }
  } catch (error) {
    const status = [400, 401, 403, 404, 409, 413, 415, 429, 503].includes(error.status) ? error.status : 503;
    if (error.retryAfter) res.setHeader("retry-after", String(error.retryAfter));
    sendJson(res, status, { error: { code: status === 503 ? "storage_unavailable" : error.code,
      message: status === 503 ? "Anahtar servisi şu anda kullanılamıyor." : error.message } });
  }
};
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.config = { api: { bodyParser: false } };

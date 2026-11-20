const net = require("node:net");

function error(status, code, message, retryAfter) {
  return Object.assign(new Error(message), { status, statusCode: status, code,
    ...(retryAfter ? { retryAfter } : {}) });
}

function setHeaders(res) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("vary", "Cookie, Origin");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function errorResponse(res, cause) {
  const status = [400, 401, 403, 404, 405, 409, 413, 415, 429].includes(cause?.status) ? cause.status : 503;
  if (cause?.retryAfter) res.setHeader("retry-after", String(cause.retryAfter));
  sendJson(res, status, { error: {
    code: status === 503 ? "storage_unavailable" : cause.code || "request_failed",
    message: status === 503 ? "Hesap servisine şu anda ulaşılamıyor. Lütfen tekrar deneyin." : cause.message,
  } });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.protocol === "https:"
      && parsed.host.toLowerCase() === host.toLowerCase()
      && req.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}

function assertSameOrigin(req) {
  if (!sameOrigin(req)) throw error(403, "origin_not_allowed", "Bu kaynaktan işlem yapılamaz.");
}

function clientIp(req) {
  const forwarded = req.headers["x-vercel-forwarded-for"];
  let ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket?.remoteAddress;
  if (typeof ip !== "string") return "unknown";
  if (ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : "unknown";
}

async function readJson(req, limit = 8192) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] || "")) {
    throw error(415, "invalid_content_type", "Content-Type application/json olmalı.");
  }
  const encoding = req.headers["content-encoding"];
  if (encoding && String(encoding).toLowerCase() !== "identity") {
    throw error(415, "unsupported_encoding", "Sıkıştırılmış istek desteklenmiyor.");
  }
  const tooLarge = () => error(413, "body_too_large", "İstek gövdesi çok büyük.");
  if (Number(req.headers["content-length"] || 0) > limit) throw tooLarge();
  let text;
  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > limit) throw tooLarge();
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (text === undefined || text === "") {
    let parsed;
    try { parsed = req.body; } catch { throw error(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli."); }
    text = Buffer.isBuffer(parsed) ? parsed.toString("utf8")
      : typeof parsed === "string" ? parsed : parsed === undefined ? "" : JSON.stringify(parsed);
  }
  if (Buffer.byteLength(text) > limit) throw tooLarge();
  let body;
  try { body = JSON.parse(text); } catch { throw error(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error(400, "invalid_json", "Geçerli bir JSON nesnesi gerekli.");
  }
  return body;
}

function assertFields(body, allowed) {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) throw error(400, "unsupported_field", "Desteklenmeyen alan: " + field);
  }
}

module.exports = { error, setHeaders, sendJson, errorResponse, sameOrigin, assertSameOrigin, clientIp, readJson, assertFields };

const crypto = require("node:crypto");

const UPSTREAM_ORIGIN = "https://api.xingchiapi.com";
const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_ROUTES = new Set([
  "GET v1/models",
  "POST v1/messages",
  "POST v1/chat/completions",
  "POST v1/responses",
]);

function sendJson(res, status, message) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: message }));
}

function isEqualSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestCredentials(req) {
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === "string"
    ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    : undefined;
  return [bearer, req.headers["x-api-key"], req.headers["x-proxy-key"]]
    .filter((value) => typeof value === "string");
}

async function readJsonBody(req) {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding.toLowerCase() !== "identity") {
    const error = new Error("Unsupported content encoding");
    error.statusCode = 415;
    throw error;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    const error = new Error("Request body too large");
    error.statusCode = 413;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const error = new Error("A valid JSON object is required");
    error.statusCode = 400;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("A JSON object is required");
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function enforceOutputLimit(payload, path) {
  const configuredLimit = Number(process.env.MAX_OUTPUT_TOKENS || 2048);
  const outputLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 8192)
    : 2048;
  const bounded = { ...payload };
  const fields = path === "v1/messages"
    ? ["max_tokens"]
    : path === "v1/responses"
      ? ["max_output_tokens"]
      : ["max_completion_tokens", "max_tokens"];

  if (fields.every((field) => bounded[field] === undefined)) {
    bounded[fields[0]] = outputLimit;
  }
  for (const field of fields) {
    if (bounded[field] === undefined) continue;
    if (!Number.isSafeInteger(bounded[field]) || bounded[field] < 1) {
      const error = new Error(`${field} must be a positive integer`);
      error.statusCode = 400;
      throw error;
    }
    if (bounded[field] > outputLimit) {
      const error = new Error(`Requested output exceeds the ${outputLimit}-token proxy limit`);
      error.statusCode = 400;
      throw error;
    }
  }

  return JSON.stringify(bounded);
}

function upstreamHeaders(req, apiKey, authMode) {
  const headers = new Headers({
    "content-type": "application/json",
    "accept-encoding": "identity",
  });

  for (const name of ["accept", "anthropic-version", "anthropic-beta", "openai-beta"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }

  if (authMode === "x-api-key") {
    headers.set("x-api-key", apiKey);
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function writeUpstreamResponse(upstream, res) {
  res.statusCode = upstream.status;
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("cache-control", "no-store");

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("allow", "GET, POST, OPTIONS");
    res.end();
    return;
  }

  const pathParts = req.query?.path;
  const path = Array.isArray(pathParts) ? pathParts.join("/") : "";
  const route = `${req.method} ${path}`;
  if (!ALLOWED_ROUTES.has(route)) {
    res.setHeader("allow", "GET, POST, OPTIONS");
    sendJson(res, 404, "Route not supported");
    return;
  }

  const expectedProxyToken = process.env.PROXY_ACCESS_TOKEN;
  if (!expectedProxyToken || expectedProxyToken.length < 32) {
    sendJson(res, 503, "Proxy authentication is not configured");
    return;
  }
  if (!requestCredentials(req).some((value) => isEqualSecret(value, expectedProxyToken))) {
    sendJson(res, 401, "Unauthorized");
    return;
  }

  const apiKey = process.env.XINGCHI_API_KEY;
  const authMode = process.env.UPSTREAM_AUTH_MODE || "authorization";
  if (!apiKey || !["authorization", "x-api-key"].includes(authMode)) {
    sendJson(res, 503, "Upstream credentials are not configured");
    return;
  }

  let body;
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, "Content-Type must be application/json");
      return;
    }
    try {
      body = enforceOutputLimit(await readJsonBody(req), path);
    } catch (error) {
      sendJson(res, error.statusCode || 400, error.message);
      return;
    }
  }

  const url = `${UPSTREAM_ORIGIN}/${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50_000);
  const abortOnClientDisconnect = () => controller.abort();
  const abortOnResponseClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on?.("aborted", abortOnClientDisconnect);
  res.on?.("close", abortOnResponseClose);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: upstreamHeaders(req, apiKey, authMode),
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    await writeUpstreamResponse(upstream, res);
  } catch {
    if (!res.headersSent) sendJson(res, 502, "Upstream request failed");
    else res.end();
  } finally {
    clearTimeout(timeout);
    req.off?.("aborted", abortOnClientDisconnect);
    res.off?.("close", abortOnResponseClose);
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };

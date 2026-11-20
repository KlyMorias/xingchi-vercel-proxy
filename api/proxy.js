const keyStore = require("../lib/key-store");
const { chatRequestToResponses, chatCompletionFromResponse, createChatStream } = require("../lib/openai-compat");
const { messagesRequestToResponses, messageFromResponse, createMessagesStream } = require("../lib/anthropic-compat");
const { collectResponse, streamResponse } = require("../lib/responses-transport");

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
    "user-agent": "codex_cli_rs/0.77.0 (KlyAPI Responses compatibility gateway)",
    "originator": "codex_cli_rs",
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

function createHandler(store = keyStore) {
return async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key, x-proxy-key, anthropic-version, anthropic-beta, openai-beta, anthropic-dangerous-direct-browser-access");
  res.setHeader("access-control-expose-headers", "retry-after, x-request-id");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("allow", "GET, POST, OPTIONS");
    res.end();
    return;
  }

  const pathParts = req.query?.path;
  const path = Array.isArray(pathParts) ? pathParts.join("/")
    : typeof pathParts === "string" ? pathParts : "";
  const route = `${req.method} ${path}`;
  if (!ALLOWED_ROUTES.has(route)) {
    res.setHeader("allow", "GET, POST, OPTIONS");
    sendJson(res, 404, "Route not supported");
    return;
  }

  const credentials = requestCredentials(req);
  const personalToken = credentials.find((value) => /^kly_[A-Za-z0-9_-]{43}$/.test(value));
  if (!personalToken) {
    sendJson(res, 401, "Unauthorized");
    return;
  }
  if (!store.isConfigured()) {
    sendJson(res, 503, "Key service is not configured");
    return;
  }

  const apiKey = process.env.XINGCHI_API_KEY;
  const authMode = process.env.UPSTREAM_AUTH_MODE || "authorization";
  if (!apiKey || !["authorization", "x-api-key"].includes(authMode)) {
    sendJson(res, 503, "Upstream credentials are not configured");
    return;
  }

  let body;
  let clientPayload;
  let clientStream = false;
  const format = path === "v1/messages" ? "messages" : path === "v1/chat/completions" ? "chat" : "responses";
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, "Content-Type must be application/json");
      return;
    }
    try {
      const payload = await readJsonBody(req);
      if (payload.model && payload.model !== "gpt-6.1-sol") {
        sendJson(res, 400, "Only gpt-6.1-sol is available");
        return;
      }
      if (payload.n !== undefined && payload.n !== 1) {
        sendJson(res, 400, "Only one output per request is supported");
        return;
      }
      if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
        sendJson(res, 400, "stream must be a boolean");
        return;
      }
      clientStream = payload.stream === true;
      clientPayload = JSON.parse(enforceOutputLimit({ ...payload, model: "gpt-6.1-sol" }, path));
      let upstreamPayload;
      if (format === "chat") upstreamPayload = chatRequestToResponses(clientPayload);
      else if (format === "messages") upstreamPayload = messagesRequestToResponses(clientPayload);
      else {
        if (typeof clientPayload.input !== "string" && !Array.isArray(clientPayload.input)) {
          sendJson(res, 400, "input must be text or an array of Responses items");
          return;
        }
        upstreamPayload = { ...clientPayload };
        if (typeof upstreamPayload.input === "string") {
          upstreamPayload.input = [{ role: "user", content: [{ type: "input_text", text: upstreamPayload.input }] }];
        }
      }
      body = JSON.stringify({ ...upstreamPayload, instructions: upstreamPayload.instructions || "You are a helpful assistant.", stream: true, store: false });
    } catch (error) {
      sendJson(res, error.statusCode || 400, error.message);
      return;
    }
  }

  let reservation;
  {
    try {
      const ip = String(req.headers["x-vercel-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
      const access = await store.reserve(personalToken, { ip, consumeDaily: req.method === "POST" });
      if (!access.ok) {
        if (access.retryAfter) res.setHeader("retry-after", String(access.retryAfter));
        sendJson(res, access.status || 401, access.message || "Unauthorized");
        return;
      }
      reservation = access.reservation;
    } catch {
      sendJson(res, 503, "Key service is temporarily unavailable");
      return;
    }
  }

  let quotaSettled = false;
  const refund = async () => {
    if (!reservation || quotaSettled) return;
    quotaSettled = true;
    await store.release(reservation);
  };
  const url = `${UPSTREAM_ORIGIN}/${req.method === "POST" ? "v1/responses" : path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 280_000);
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
    if (!upstream.ok) {
      await refund();
      await writeUpstreamResponse(upstream, res);
    } else if (req.method === "GET") {
      await writeUpstreamResponse(upstream, res);
    } else if (clientStream) {
      const adapter = format === "chat" ? createChatStream("gpt-6.1-sol", { includeUsage: clientPayload.stream_options?.include_usage === true })
        : format === "messages" ? createMessagesStream("gpt-6.1-sol") : null;
      await streamResponse(upstream, res, format, adapter);
    } else {
      const response = await collectResponse(upstream);
      const result = format === "chat" ? chatCompletionFromResponse(response, "gpt-6.1-sol")
        : format === "messages" ? messageFromResponse(response, "gpt-6.1-sol") : response;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(result));
    }
  } catch (error) {
    try { await refund(); } catch { /* Reserved requests expire at the daily reset. */ }
    if (!res.destroyed && !res.headersSent) sendJson(res, 502, "Upstream request failed");
    else if (!res.destroyed) {
      const failure = { error: { type: "api_error", message: "Upstream generation failed" } };
      res.end(format === "messages" ? `event: error\ndata: ${JSON.stringify({ type: "error", ...failure })}\n\n`
        : `data: ${JSON.stringify(failure)}\n\n`);
    }
  } finally {
    clearTimeout(timeout);
    req.off?.("aborted", abortOnClientDisconnect);
    res.off?.("close", abortOnResponseClose);
  }
};
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.config = { api: { bodyParser: false } };

const http = require("node:http");
const keyStore = require("./lib/key-store");
const { createHandler } = require("./api/proxy");

function compactLargeRequest(req) {
  const length = req.headers["content-length"];
  const encoding = req.headers["content-encoding"];
  if (typeof global.gc === "function" && (length === undefined || Number(length) >= 4 * 1024 * 1024
    || (typeof encoding === "string" && encoding.trim().toLowerCase() !== "identity"))) global.gc();
}

const GATEWAY_BODY_LIMITS = Object.freeze({ maxWireBytes: 50 * 1024 * 1024, maxDecodedBytes: 50 * 1024 * 1024,
  maxDepth: 128, maxStructureTokens: 100_000, afterRead: compactLargeRequest });
const aliases = new Map();
for (const prefix of ["/v1", "/api", "/api/v1"]) {
  for (const [suffix, method] of [["models", "GET"], ["responses", "POST"],
    ["chat/completions", "POST"], ["messages", "POST"]]) {
    aliases.set(`${prefix}/${suffix}`, { path: `v1/${suffix}`, method });
  }
}

function positiveInteger(value, name, maximum = 2_147_483_647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be a positive integer up to ${maximum}`);
  return value;
}

function personalToken(req) {
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : undefined;
  return [bearer, req.headers["x-api-key"], req.headers["x-proxy-key"]]
    .find((value) => typeof value === "string" && /^kly_[A-Za-z0-9_-]{43}$/.test(value));
}

function sendJson(res, status, error) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error }));
}

function createGateway({ store = keyStore, maxConcurrentRequests = 1, uploadTimeoutMs = 120_000,
  headersTimeoutMs = 120_000, keepaliveIntervalMs = 8000 } = {}) {
  positiveInteger(maxConcurrentRequests, "maxConcurrentRequests", 16);
  positiveInteger(uploadTimeoutMs, "uploadTimeoutMs");
  positiveInteger(headersTimeoutMs, "headersTimeoutMs");
  if (typeof store.authenticate !== "function") throw new TypeError("The key store must support read-only authentication");
  const dispatch = createHandler(store, { keepaliveIntervalMs, bodyLimits: GATEWAY_BODY_LIMITS });
  let activeRequests = 0;

  async function handle(req, res, expectContinue = false) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("access-control-allow-origin", "*");

    // A rejected upload may still have unread bytes. Close after flushing the
    // response rather than destroying its socket or draining an unbounded body.
    const end = res.end;
    res.end = function (...args) {
      if (!req.complete && !this.headersSent) {
        this.shouldKeepAlive = false;
        this.setHeader("connection", "close");
        const chunk = args[0];
        if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
          const encoding = typeof args[1] === "string" ? args[1] : undefined;
          const callback = args.find((value) => typeof value === "function");
          this.setHeader("content-length", String(Buffer.byteLength(chunk, encoding)));
          // Flush the complete error body first. Closing a socket while an
          // oversized client is still uploading can otherwise reset the TCP
          // connection before the client receives the error response.
          this.write(chunk, encoding, () => { if (!this.destroyed) end.call(this, callback); });
          return this;
        }
      }
      return end.apply(this, args);
    };

    // Never trust a client-supplied forwarding header. The shared proxy uses
    // the actual socket address when x-vercel-forwarded-for is absent.
    delete req.headers["x-vercel-forwarded-for"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-real-ip"];

    // Compare the literal request target: URL normalization must not turn an
    // encoded path, traversal, /api/proxy or arbitrary query into a public route.
    const pathname = (req.url || "").split("?", 1)[0];
    if (pathname === "/healthz") {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, "Method not allowed");
      } else {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end('{"ok":true}');
      }
      return;
    }
    const route = aliases.get(pathname);
    if (!route) { sendJson(res, 404, "Route not supported"); return; }
    if (req.method !== route.method && req.method !== "OPTIONS") {
      res.setHeader("allow", `${route.method}, OPTIONS`);
      sendJson(res, 405, "Method not allowed");
      return;
    }
    req.query = { path: route.path };
    if (req.method === "OPTIONS") { await dispatch(req, res); return; }

    const declared = req.headers["content-length"];
    if (typeof declared === "string" && Number(declared) > GATEWAY_BODY_LIMITS.maxWireBytes) {
      sendJson(res, 413, `Request body exceeds the ${GATEWAY_BODY_LIMITS.maxWireBytes}-byte ingress limit.`);
      return;
    }

    let admitted = false;
    if (req.method === "POST") {
      if (activeRequests >= maxConcurrentRequests) {
        res.setHeader("retry-after", "2");
        sendJson(res, 503, "Gateway is busy. Retry shortly.");
        return;
      }
      activeRequests++;
      admitted = true;
    }
    try {
      if (admitted) {
        const token = personalToken(req);
        if (!token) { sendJson(res, 401, "Unauthorized"); return; }
        let access;
        try { access = await store.authenticate(token); }
        catch {
          if (res.destroyed) return;
          res.setHeader("retry-after", "2");
          sendJson(res, 503, "Key service is temporarily unavailable");
          return;
        }
        // The requester may disconnect while authentication waits on storage.
        if (req.aborted || res.destroyed) return;
        if (!access?.ok) { sendJson(res, 401, "Unauthorized"); return; }
      }
      if (expectContinue) res.writeContinue();
      await dispatch(req, res);
    } finally {
      // Keep the slot until processing finishes, even if the client closes its
      // socket while a storage or provider operation is still unwinding.
      if (admitted) {
        compactLargeRequest(req);
        activeRequests--;
      }
    }
  }

  const listener = (req, res, expectContinue) => {
    handle(req, res, expectContinue).catch(() => {
      // Do not expose request data, credentials or internal exception messages.
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, 500, "Gateway request failed");
    });
  };
  const server = http.createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: Math.min(headersTimeoutMs, uploadTimeoutMs),
    requestTimeout: uploadTimeoutMs,
    connectionsCheckingInterval: Math.min(1000, uploadTimeoutMs),
    // Render's edge reuses idle connections for up to 75 seconds. Keep Node's
    // connection alive longer so the edge does not reuse a closed socket.
    keepAliveTimeout: 120_000,
  }, listener);
  server.on("checkContinue", (req, res) => listener(req, res, true));
  server.maxRequestsPerSocket = 1000;
  return server;
}

if (require.main === module) {
  if (typeof global.gc !== "function") {
    console.error("Start the gateway with npm start to enable bounded-memory uploads.");
    process.exitCode = 1;
  } else {
    try {
      const port = positiveInteger(Number(process.env.PORT || 3000), "PORT", 65535);
      const maxConcurrentRequests = positiveInteger(Number(process.env.GATEWAY_MAX_CONCURRENT_REQUESTS || 1), "GATEWAY_MAX_CONCURRENT_REQUESTS", 16);
      const uploadTimeoutMs = positiveInteger(Number(process.env.GATEWAY_UPLOAD_TIMEOUT_MS || 120_000), "GATEWAY_UPLOAD_TIMEOUT_MS");
      const server = createGateway({ maxConcurrentRequests, uploadTimeoutMs });
      server.listen(port, "0.0.0.0", () => {
        console.log(JSON.stringify({ scope: "gateway", event: "listening", port,
          max_wire_bytes: GATEWAY_BODY_LIMITS.maxWireBytes, max_concurrent_requests: maxConcurrentRequests }));
      });
      server.on("error", () => { console.error("Gateway could not start"); process.exitCode = 1; });
      const shutdown = () => {
        const timer = setTimeout(() => server.closeAllConnections(), 30_000);
        timer.unref();
        server.close(() => clearTimeout(timer));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch {
      console.error("Gateway configuration is invalid");
      process.exitCode = 1;
    }
  }
}

module.exports = { createGateway, GATEWAY_BODY_LIMITS };

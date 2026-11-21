const { serviceInfo } = require("../lib/models");

module.exports = function status(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  res.statusCode = 200;
  res.end(req.method === "HEAD" ? undefined : JSON.stringify({
    name: "KlyAPI", key_page: "/key", base_url: "https://klyapi.vercel.app/api/v1",
    ...serviceInfo, authentication: "Bearer API_KEY",
    provider_status: serviceInfo.generation_available ? "available" : "unavailable",
    endpoints: ["/api/v1/models", "/api/v1/responses", "/api/v1/chat/completions", "/api/v1/messages"],
  }));
};

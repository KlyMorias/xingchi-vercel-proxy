(function expose(root, factory) {
  const config = factory();
  if (typeof module === "object" && module.exports) module.exports = config;
  else root.KlyCodexConfig = config;
})(typeof window === "object" ? window : globalThis, function configure() {
  "use strict";
  const PLACEHOLDER = "KLYAPI_API_ANAHTARIN";
  function buildConfig(key) {
    // Only a personal gateway token may enter this generated local file.
    // Provider secrets and arbitrary strings can never become TOML content.
    const token = typeof key === "string" && /^kly_[A-Za-z0-9_-]{43}$/.test(key) ? key : PLACEHOLDER;
    return [
      'model_provider = "KlyAPI"',
      'model = "gpt-6.1-sol"',
      'review_model = "gpt-6.1-sol"',
      'web_search = "live"',
      "",
      "[model_providers.KlyAPI]",
      'name = "KlyAPI"',
      'base_url = "https://klyapi.vercel.app/api/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      `experimental_bearer_token = "${token}"`,
      "supports_websockets = false",
      "stream_idle_timeout_ms = 300000",
      "",
      "[features]",
      "image_generation = false",
      "goals = true",
      "enable_request_compression = false",
      "",
    ].join("\n");
  }
  return Object.freeze({ buildConfig, PLACEHOLDER });
});

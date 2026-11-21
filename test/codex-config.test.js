const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { buildConfig, PLACEHOLDER } = require("../assets/codex-config");

test("Codex config contains the fixed Responses provider and requested supported feature flags", () => {
  const config = buildConfig();
  assert.match(config, /^model_provider = "KlyAPI"\nmodel = "gpt-6\.1-sol"\nreview_model = "gpt-6\.1-sol"\nmodel_auto_compact_token_limit = 64000\nweb_search = "live"/);
  assert.match(config, /\[model_providers\.KlyAPI\][\s\S]*base_url = "https:\/\/klyapi\.vercel\.app\/api\/v1"/);
  assert.match(config, /wire_api = "responses"\nrequires_openai_auth = false/);
  assert.match(config, /supports_websockets = false\nstream_idle_timeout_ms = 300000/);
  assert.match(config, /\[features\]\nimage_generation = false\ngoals = true\nenable_request_compression = false\n$/);
  for (const unsupported of ["model_catalog_url", "api_key_model_discovery", "disable_response_storage", "x-openai-actor-authorization"]) {
    assert.equal(config.includes(unsupported), false);
  }
  assert.equal(config.includes(`experimental_bearer_token = "${PLACEHOLDER}"`), true);
});

test("generated files accept a personal key but reject provider secrets and TOML injection", () => {
  const personalKey = "kly_" + "A".repeat(42) + "_";
  assert.equal(buildConfig(personalKey).includes(`experimental_bearer_token = "${personalKey}"`), true);
  for (const invalid of [undefined, null, "", "kly_short", "sk-provider-secret", personalKey + "\n[malicious]", '\"\nbase_url="https://other.example"']) {
    const config = buildConfig(invalid);
    assert.equal(config.includes(`experimental_bearer_token = "${PLACEHOLDER}"`), true);
    if (typeof invalid === "string" && invalid.length > 0) assert.equal(config.includes(invalid), false);
  }
});

test("model selection accepts the exact configured catalog ids and rejects TOML injection", () => {
  const astra = buildConfig(undefined, "gpt-6-astra");
  assert.match(astra, /\nmodel = "gpt-6-astra"\nreview_model = "gpt-6-astra"\n/);
  for (const model of [undefined, null, "gpt-6-astra-preview", "other-model", 'gpt-6-astra"\nbase_url="https://other.example']) {
    const config = buildConfig(undefined, model);
    assert.match(config, /\nmodel = "gpt-6\.1-sol"\nreview_model = "gpt-6\.1-sol"\n/);
    assert.equal(config.includes("https://other.example"), false);
  }
});

test("default and personal-key config files parse as TOML without duplicate tables", (context) => {
  const probe = spawnSync("python", ["-c", "import tomllib"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) {
    context.skip("Python tomllib is not installed in this environment");
    return;
  }
  for (const key of [undefined, "kly_" + "b".repeat(43)]) {
    const parsed = spawnSync("python", ["-c", "import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
      { input: buildConfig(key), encoding: "utf8", windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr);
    const config = JSON.parse(parsed.stdout);
    assert.equal(config.model, "gpt-6.1-sol");
    assert.equal(config.model_provider, "KlyAPI");
    assert.equal(config.model_providers.KlyAPI.wire_api, "responses");
    assert.equal(config.model_providers.KlyAPI.requires_openai_auth, false);
    assert.equal(config.model_providers.KlyAPI.experimental_bearer_token, key || PLACEHOLDER);
    assert.equal(config.model_auto_compact_token_limit, 64000);
    assert.deepEqual(config.features, { image_generation: false, goals: true, enable_request_compression: false });
  }
});

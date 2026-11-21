const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_MODEL, availableModels, resolveModel, modelCatalog, serviceInfo } = require("../lib/models");
const status = require("../api/status");

test("Astra balance notice is fixed public metadata and does not expose its credential", () => {
  const models = availableModels({ XINGCHI_ASTRA_API_KEY: "private-astra-credential", XINGCHI_ASTRA_BALANCE_REQUIRED: "true" });
  assert.equal(models[0].availability, "balance_required");
  assert.match(models[0].note, /yetersiz bakiye/);
  assert.equal(JSON.stringify(models).includes("private-astra-credential"), false);
});

test("registry uses exact verified IDs, dedicated credentials and Sol-only legacy fallback", () => {
  const env = { XINGCHI_API_KEY: "legacy", XINGCHI_SOL_API_KEY: "sol", XINGCHI_ASTRA_API_KEY: "astra" };
  assert.equal(DEFAULT_MODEL, "gpt-6.1-sol");
  assert.equal(resolveModel(undefined, env).apiKey, "sol");
  assert.equal(resolveModel("gpt-6-astra", env).apiKey, "astra");
  assert.equal(resolveModel("gpt-6.1-sol", { XINGCHI_API_KEY: "legacy" }).apiKey, "legacy");
  assert.equal(resolveModel("gpt-6-astra", { XINGCHI_API_KEY: "legacy" }).apiKey, null);
  assert.equal(resolveModel("gpt-6.1-astra", env), null);
  assert.equal(resolveModel("GPT-6-ASTRA", env), null);
  assert.equal(resolveModel("constructor", env), null);
  assert.deepEqual(availableModels(env), [{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol" }, { id: "gpt-6-astra", name: "GPT 6 Astra" }]);
  assert.deepEqual(availableModels({ XINGCHI_SOL_API_KEY: "  ", XINGCHI_ASTRA_API_KEY: "astra" }), [{ id: "gpt-6-astra", name: "GPT 6 Astra" }]);
  assert.deepEqual(modelCatalog({}), { object: "list", data: [] });
});

test("service and status catalogs update from server configuration without exposing keys or environment names", () => {
  const original = { ...process.env };
  try {
    delete process.env.XINGCHI_API_KEY;
    delete process.env.XINGCHI_SOL_API_KEY;
    delete process.env.XINGCHI_ASTRA_API_KEY;
    assert.equal(serviceInfo.generation_available, false);
    assert.deepEqual(serviceInfo.models, []);
    process.env.XINGCHI_SOL_API_KEY = "server-sol-secret";
    process.env.XINGCHI_ASTRA_API_KEY = "server-astra-secret";
    const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
    status({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.model, "gpt-6.1-sol");
    assert.equal(data.generation_available, true);
    assert.deepEqual(data.models.map(({ id }) => id), ["gpt-6.1-sol", "gpt-6-astra"]);
    assert.equal(data.provider_status, "available");
    assert.doesNotMatch(res.body, /server-sol-secret|server-astra-secret|XINGCHI_/);
    delete process.env.XINGCHI_SOL_API_KEY;
    assert.deepEqual(serviceInfo.models, [{ id: "gpt-6-astra", name: "GPT 6 Astra" }]);
  } finally { process.env = original; }
});

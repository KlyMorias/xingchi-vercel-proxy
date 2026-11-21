const DEFAULT_MODEL = "gpt-6.1-sol";
const definitions = Object.freeze([
  Object.freeze({ id: DEFAULT_MODEL, name: "GPT 6.1 Sol", env: "XINGCHI_SOL_API_KEY", legacyEnv: "XINGCHI_API_KEY" }),
  Object.freeze({ id: "gpt-6-astra", name: "GPT 6 Astra", env: "XINGCHI_ASTRA_API_KEY" }),
]);

function keyFor(model, env) {
  const value = env[model.env]?.trim() || (model.legacyEnv ? env[model.legacyEnv]?.trim() : "");
  return value || null;
}

// Public catalogs contain only fixed identifiers and names, never credentials or
// the environment variable names used by the server-side routing table.
function availableModels(env = process.env) {
  return definitions.filter((model) => keyFor(model, env)).map(({ id, name }) => ({ id, name,
    ...(id === "gpt-6-astra" && env.XINGCHI_ASTRA_BALANCE_REQUIRED === "true"
      ? { availability: "balance_required", note: "21 Kasım testinde sağlayıcı bu model grubu için yetersiz bakiye bildirdi. Bakiye eklendikten sonra yeniden deneyebilirsin." }
      : {}) }));
}

function resolveModel(id = DEFAULT_MODEL, env = process.env) {
  const model = definitions.find((candidate) => candidate.id === id);
  if (!model) return null;
  return { id: model.id, name: model.name, apiKey: keyFor(model, env) };
}

function modelCatalog(env = process.env) {
  return { object: "list", data: availableModels(env).map(({ id }) => ({ id, object: "model", created: 0, owned_by: "klyapi" })) };
}

const serviceInfo = Object.freeze({ model: DEFAULT_MODEL,
  get models() { return availableModels(); },
  get generation_available() { return availableModels().length > 0; },
  get message() {
    const count = availableModels().length;
    return count ? `${count} model tanımlı. Erişim durumlarını Modeller sekmesinden görebilirsin.`
      : "Şu anda kullanılabilir model yapılandırılmamış.";
  } });

module.exports = { DEFAULT_MODEL, availableModels, resolveModel, modelCatalog, serviceInfo };

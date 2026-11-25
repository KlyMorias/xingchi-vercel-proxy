// Hold enough budget for the serialized input plus the requested output ceiling.
// This is a conservative admission estimate, never the final token charge.
function estimatedTokens(body, outputCeiling) {
  // The proxy already validated this value while constructing the payload.
  // Reuse it to avoid parsing another complete copy of a large conversation.
  const output = outputCeiling === undefined ? JSON.parse(body).max_output_tokens : outputCeiling;
  const estimate = Buffer.byteLength(body, "utf8") + output;
  if (!Number.isSafeInteger(output) || output < 1 || !Number.isSafeInteger(estimate)) {
    throw Object.assign(new Error("Requested token budget is invalid"), { statusCode: 400 });
  }
  return estimate;
}

function normalizeTokenUsage(usage) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const invalid = () => Object.assign(new Error("Provider did not return valid token usage"),
    { status: 502, statusCode: 502, code: "invalid_token_usage" });
  if (!usage || typeof usage !== "object" || Array.isArray(usage)
      || ![usage.input_tokens, usage.output_tokens].every(count)
      || !count(usage.input_tokens + usage.output_tokens)) throw invalid();
  const total = usage.input_tokens + usage.output_tokens;
  if (usage.total_tokens !== undefined && (!count(usage.total_tokens) || usage.total_tokens !== total)) throw invalid();
  for (const [field, parent] of [["input_tokens_details", usage.input_tokens], ["output_tokens_details", usage.output_tokens]]) {
    const details = usage[field];
    if (details === undefined || details === null) continue;
    if (typeof details !== "object" || Array.isArray(details)) throw invalid();
    // Compatible providers also send nested *_tokens_details and attribution
    // metadata. Only *_tokens fields are counters; metadata is never charged.
    for (const [name, value] of Object.entries(details)) {
      if (name.endsWith("_tokens") && (!count(value) || value > parent)) throw invalid();
    }
  }
  // Cached input and reasoning tokens are already included in these totals.
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    total_tokens: total };
}

function actualTokens(response) { return normalizeTokenUsage(response?.usage); }

module.exports = { estimatedTokens, actualTokens, normalizeTokenUsage };

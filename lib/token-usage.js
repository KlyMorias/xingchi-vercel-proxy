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

function actualTokens(response) {
  const usage = response?.usage;
  if (!usage || ![usage.input_tokens, usage.output_tokens].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Number.isSafeInteger(usage.input_tokens + usage.output_tokens)) {
    throw Object.assign(new Error("Provider did not return valid token usage"), { code: "invalid_token_usage" });
  }
  // Cached input and reasoning tokens are already included in these totals.
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens };
}

module.exports = { estimatedTokens, actualTokens };

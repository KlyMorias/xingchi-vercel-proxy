const { promisify } = require("node:util");
const zlib = require("node:zlib");

// Keep the wire limit below Vercel's standard function ingress limit. Compressed
// Codex conversations may expand further, but decompression must remain bounded.
const MAX_WIRE_BYTES = 4_400_000;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const decompressors = Object.freeze({ gzip: promisify(zlib.gunzip), deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress), zstd: promisify(zlib.zstdDecompress) });

function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function wireTooLarge(limit) {
  return fail(413, `Request body exceeds the ${limit}-byte ingress limit. Reduce the request or use the large-request gateway.`);
}
function decodedTooLarge(limit) {
  return fail(413, `Decompressed request body exceeds the ${limit}-byte limit. Reduce the request and retry.`);
}

function checkJsonComplexity(bytes, maxDepth, maxStructureTokens) {
  if (maxDepth === undefined && maxStructureTokens === undefined) return;
  let inString = false;
  let depth = 0;
  let structureTokens = 0;
  const tooComplex = () => fail(400, "JSON request exceeds the gateway complexity limit.");
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (inString) {
      // An escape consumes the next byte. UTF-8 continuation bytes cannot be
      // quotes, slashes or JSON punctuation, so no text allocation is needed.
      if (byte === 0x5c) index++;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) { inString = true; continue; }
    if (byte === 0x7b || byte === 0x5b) {
      depth++;
      structureTokens++;
      if (maxDepth !== undefined && depth > maxDepth) throw tooComplex();
    } else if (byte === 0x7d || byte === 0x5d) {
      depth--;
    } else if (byte === 0x2c || byte === 0x3a) {
      structureTokens++;
    }
    if (maxStructureTokens !== undefined && structureTokens > maxStructureTokens) throw tooComplex();
  }
}

async function readJsonBody(req, { maxWireBytes = MAX_WIRE_BYTES, maxDecodedBytes = MAX_DECODED_BYTES,
  maxDepth, maxStructureTokens } = {}) {
  if (![maxWireBytes, maxDecodedBytes].every((value) => Number.isSafeInteger(value) && value > 0)
    || [maxDepth, maxStructureTokens].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
    throw fail(500, "Request body limits are not configured correctly.");
  }
  const header = req.headers["content-encoding"];
  const encoding = header === undefined ? "identity" : typeof header === "string" ? header.trim().toLowerCase() : "";
  if (encoding !== "identity" && !Object.hasOwn(decompressors, encoding)) {
    throw fail(415, "Unsupported content encoding. Use identity, gzip, deflate, br or zstd without stacking encodings.");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length))) {
    throw fail(400, "A valid Content-Length is required when provided.");
  }
  if (length !== undefined && Number(length) > maxWireBytes) throw wireTooLarge(maxWireBytes);

  const chunks = [];
  let bytes = 0;
  // Returning early from IncomingMessage's default async iterator destroys the
  // socket, losing the 413 response. Leave the unread stream paused instead;
  // the HTTP adapter closes the connection after sending its error response.
  const source = typeof req.iterator === "function" ? req.iterator({ destroyOnReturn: false }) : req;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxWireBytes) throw wireTooLarge(maxWireBytes);
    chunks.push(buffer);
  }
  let decoded = Buffer.concat(chunks, bytes);
  if (encoding !== "identity") {
    try {
      decoded = await decompressors[encoding](decoded, { maxOutputLength: maxDecodedBytes });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") throw decodedTooLarge(maxDecodedBytes);
      throw fail(400, "Compressed request body is invalid or incomplete.");
    }
  }
  if (decoded.length > maxDecodedBytes) throw decodedTooLarge(maxDecodedBytes);

  // A byte limit alone does not bound JSON's object heap. The optional ingress
  // limits reject huge container/member counts before allocating that heap;
  // quoted photo data, text and escaped punctuation do not consume this budget.
  checkJsonComplexity(decoded, maxDepth, maxStructureTokens);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)); }
  catch { throw fail(400, "A valid JSON object is required"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(400, "A JSON object is required");
  return parsed;
}

module.exports = { readJsonBody, MAX_WIRE_BYTES, MAX_DECODED_BYTES };

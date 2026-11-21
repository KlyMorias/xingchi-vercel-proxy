const { promisify } = require("node:util");
const zlib = require("node:zlib");

// Keep the wire limit below Vercel's standard function ingress limit. Compressed
// Codex conversations may expand further, but decompression must remain bounded.
const MAX_WIRE_BYTES = 4_400_000;
const MAX_DECODED_BYTES = 16_000_000;
const decompressors = Object.freeze({ gzip: promisify(zlib.gunzip), deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress), zstd: promisify(zlib.zstdDecompress) });

function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function wireTooLarge() {
  return fail(413, "Request body exceeds the 4.4 MB ingress limit. Enable request compression or compact the conversation.");
}
function decodedTooLarge() {
  return fail(413, "Decompressed request body exceeds the 16 MB limit. Compact the conversation and retry.");
}

async function readJsonBody(req) {
  const header = req.headers["content-encoding"];
  const encoding = header === undefined ? "identity" : typeof header === "string" ? header.trim().toLowerCase() : "";
  if (encoding !== "identity" && !Object.hasOwn(decompressors, encoding)) {
    throw fail(415, "Unsupported content encoding. Use identity, gzip, deflate, br or zstd without stacking encodings.");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length))) {
    throw fail(400, "A valid Content-Length is required when provided.");
  }
  if (length !== undefined && Number(length) > MAX_WIRE_BYTES) throw wireTooLarge();

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WIRE_BYTES) throw wireTooLarge();
    chunks.push(buffer);
  }
  let decoded = Buffer.concat(chunks, bytes);
  if (encoding !== "identity") {
    try {
      decoded = await decompressors[encoding](decoded, { maxOutputLength: MAX_DECODED_BYTES });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") throw decodedTooLarge();
      throw fail(400, "Compressed request body is invalid or incomplete.");
    }
  }
  if (decoded.length > MAX_DECODED_BYTES) throw decodedTooLarge();

  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)); }
  catch { throw fail(400, "A valid JSON object is required"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(400, "A JSON object is required");
  return parsed;
}

module.exports = { readJsonBody, MAX_WIRE_BYTES, MAX_DECODED_BYTES };

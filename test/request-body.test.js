const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } = require("node:zlib");
const { readJsonBody, MAX_WIRE_BYTES, MAX_DECODED_BYTES } = require("../lib/request-body");

function request(body, headers = {}, chunkBytes = 65536) {
  return { headers, async *[Symbol.asyncIterator]() {
    for (let offset = 0; offset < body.length; offset += chunkBytes) yield body.subarray(offset, offset + chunkBytes);
  } };
}

test("identity requests accept exactly 4.4 MB, including multibyte UTF-8, and reject the next byte", async () => {
  const text = "é".repeat((MAX_WIRE_BYTES - 12) / 2);
  const body = Buffer.from(JSON.stringify({ input: text }));
  assert.equal(body.length, MAX_WIRE_BYTES);
  const parsed = await readJsonBody(request(body, { "content-length": String(body.length), "content-encoding": " Identity " }));
  assert.equal(parsed.input, text);
  await assert.rejects(readJsonBody(request(Buffer.concat([body, Buffer.from(" ")]))), { statusCode: 413 });
});

test("Content-Length precheck rejects oversized declarations and actual bytes cannot bypass it", async () => {
  let read = false;
  await assert.rejects(readJsonBody({ headers: { "content-length": String(MAX_WIRE_BYTES + 1) },
    async *[Symbol.asyncIterator]() { read = true; } }), { statusCode: 413 });
  assert.equal(read, false);
  await assert.rejects(readJsonBody(request(Buffer.alloc(MAX_WIRE_BYTES + 1, 32), { "content-length": "2" })), { statusCode: 413 });
  for (const length of ["-1", "NaN", "1.1", "2,2", ["2"], 2]) {
    await assert.rejects(readJsonBody(request(Buffer.from("{}"), { "content-length": length })), { statusCode: 400 });
  }
});

test("gzip, deflate, brotli and zstd decode bounded large JSON including mixed-case headers", async () => {
  const payload = { input: "conversation ".repeat(100000), model: "gpt-6-astra" };
  const bytes = Buffer.from(JSON.stringify(payload));
  for (const [encoding, compress] of [["GZip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync], ["zstd", zstdCompressSync]]) {
    const body = compress(bytes);
    assert.deepEqual(await readJsonBody(request(body, { "content-encoding": encoding, "content-length": String(body.length) }, 17)), payload);
  }
});

test("compressed requests may expand beyond ingress but never beyond the 16 MB decode cap", async () => {
  const body = Buffer.from(JSON.stringify({ input: "x".repeat(MAX_DECODED_BYTES - 12) }));
  assert.equal(body.length, MAX_DECODED_BYTES);
  const compressed = zstdCompressSync(body);
  assert.ok(compressed.length < MAX_WIRE_BYTES);
  assert.equal((await readJsonBody(request(compressed, { "content-encoding": "zstd" }))).input.length, MAX_DECODED_BYTES - 12);
  // A native maxOutputLength check stops expansion rather than allocating an
  // arbitrarily sized result and checking only after decompression finishes.
  await assert.rejects(readJsonBody(request(gzipSync(Buffer.concat([body, Buffer.from(" ")])),
    { "content-encoding": "gzip" })), { statusCode: 413 });
});

test("invalid compressed streams, invalid JSON and invalid UTF-8 return safe 400 responses", async () => {
  for (const encoding of ["gzip", "deflate", "br", "zstd"]) {
    await assert.rejects(readJsonBody(request(Buffer.from("private malformed bytes"), { "content-encoding": encoding })),
      { statusCode: 400, message: "Compressed request body is invalid or incomplete." });
  }
  for (const body of [Buffer.from("not JSON"), Buffer.from("[]"), Buffer.from("null"),
    Buffer.from([123, 34, 105, 34, 58, 34, 255, 34, 125])]) {
    await assert.rejects(readJsonBody(request(body)), { statusCode: 400 });
  }
});

test("unknown, empty, array and stacked content encodings are rejected before reading bytes", async () => {
  for (const encoding of ["", "compress", "gzip, br", "identity,gzip", ["gzip", "br"]]) {
    let read = false;
    await assert.rejects(readJsonBody({ headers: { "content-encoding": encoding },
      async *[Symbol.asyncIterator]() { read = true; yield Buffer.from("{}"); } }), { statusCode: 415 });
    assert.equal(read, false);
  }
});

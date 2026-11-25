const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { readJsonBody } = require("../lib/request-body");

const complexityError = { statusCode: 400, message: "JSON request exceeds the gateway complexity limit." };

function request(body, { chunkBytes = 65536, headers = {} } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { headers, async *[Symbol.asyncIterator]() {
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) yield bytes.subarray(offset, offset + chunkBytes);
  } };
}

test("large UTF-8 strings and property names containing escaped JSON punctuation do not consume structure budget", async () => {
  const payload = { 'punctuation:,{["\\': '{},:["\\\"🙂世界'.repeat(100000) };
  const result = await readJsonBody(request(JSON.stringify(payload)), { maxDepth: 1, maxStructureTokens: 2 });
  assert.deepEqual(result, payload);
});

test("quotes and odd/even backslash escapes survive tiny UTF-8 chunk boundaries", async () => {
  const payload = { input: ['"', "\\", '\\"', "\\\\", '\\\\"', "中🙂", "{[,:"] .join("|") };
  assert.deepEqual(await readJsonBody(request(JSON.stringify(payload), { chunkBytes: 1 }),
    { maxDepth: 1, maxStructureTokens: 2 }), payload);
  // A closing quote after an escaped backslash must expose the following comma.
  await assert.rejects(readJsonBody(request('{"input":"\\\\","next":{}}', { chunkBytes: 1 }),
    { maxDepth: 1 }), complexityError);
});

test("depth counts the root object and accepts the exact boundary before rejecting the next container", async () => {
  const boundary = '{"input":[{}]}';
  assert.deepEqual(await readJsonBody(request(boundary), { maxDepth: 3 }), { input: [{}] });
  await assert.rejects(readJsonBody(request(boundary), { maxDepth: 2 }), complexityError);
  const nested = depth => '{"input":' + "[".repeat(depth - 1) + '"x"' + "]".repeat(depth - 1) + "}";
  assert.ok(await readJsonBody(request(nested(128)), { maxDepth: 128 }));
  await assert.rejects(readJsonBody(request(nested(129)), { maxDepth: 128 }), complexityError);
});

test("structure counts containers, colons and commas at the exact configured boundary", async () => {
  // root { + colon + [ + { + comma + { = six structure tokens; closing tokens are free.
  const json = '{"input":[{},{}]}';
  assert.deepEqual(await readJsonBody(request(json), { maxStructureTokens: 6 }), { input: [{}, {}] });
  await assert.rejects(readJsonBody(request(json), { maxStructureTokens: 5 }), complexityError);
});

test("many empty objects and primitive array entries are rejected before JSON parsing", async () => {
  const objectArray = '{"input":[' + Array(50001).fill("{}").join(",") + "]}";
  const primitiveArray = '{"input":[' + Array(100001).fill("0").join(",") + "]}";
  for (const json of [objectArray, primitiveArray]) {
    await assert.rejects(readJsonBody(request(json), { maxDepth: 128, maxStructureTokens: 100000 }), complexityError);
  }
  // Without an explicit gateway budget the existing body-reader behavior stays intact.
  assert.equal((await readJsonBody(request(objectArray))).input.length, 50001);
  assert.equal((await readJsonBody(request(primitiveArray))).input.length, 100001);
});

test("complexity checks the decompressed representation and supports split compressed input", async () => {
  const json = '{"input":[{},{},{}]}';
  const body = gzipSync(Buffer.from(json));
  const compressedRequest = () => request(body, { chunkBytes: 3, headers: { "content-encoding": "gzip" } });
  await assert.rejects(readJsonBody(compressedRequest(), { maxStructureTokens: 6 }), complexityError);
  assert.deepEqual(await readJsonBody(compressedRequest(), { maxDepth: 3, maxStructureTokens: 8 }),
    { input: [{}, {}, {}] });
});

test("invalid JSON and invalid UTF-8 still fail with safe parse errors", async () => {
  for (const body of ["{", '{"input":"unterminated\\', '{"input":1,}', "[]", "null",
    Buffer.from([123, 34, 105, 34, 58, 34, 255, 34, 125])]) {
    await assert.rejects(readJsonBody(request(body, { chunkBytes: 2 }),
      { maxDepth: 128, maxStructureTokens: 100000 }), error => error.statusCode === 400 &&
        ["A valid JSON object is required", "A JSON object is required"].includes(error.message));
  }
});

test("invalid optional complexity limits fail as configuration errors", async () => {
  for (const name of ["maxDepth", "maxStructureTokens"]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, null, "1000"]) {
      await assert.rejects(readJsonBody(request("{}"), { [name]: value }),
        { statusCode: 500, message: "Request body limits are not configured correctly." });
    }
  }
});

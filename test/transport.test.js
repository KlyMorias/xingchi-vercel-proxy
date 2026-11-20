const test = require("node:test");
const assert = require("node:assert/strict");
const { collectResponse, eventsFrom, streamResponse } = require("../lib/responses-transport");

function upstream(chunks) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("decodes SSE split within UTF-8 and CRLF separators", async () => {
  const bytes = Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Merhaba dünya"}\r\n\r\n');
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const result = [];
  for await (const event of eventsFrom(upstream(chunks).body)) result.push(event);
  assert.deepEqual(result, [{ type: "response.output_text.delta", delta: "Merhaba dünya" }]);
});

test("nonstream clients receive the final Responses object instead of SSE", async () => {
  const response = { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] };
  const source = upstream([Buffer.from(`data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`),
    Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`)]);
  assert.deepEqual(await collectResponse(source), response);
});

test("a truncated provider stream does not become a successful response", async () => {
  const source = upstream([Buffer.from('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')]);
  await assert.rejects(collectResponse(source), { statusCode: 502 });
});

test("a provider terminal failure is surfaced instead of hiding it", async () => {
  const source = upstream([Buffer.from('data: {"type":"response.failed","response":{"error":{"message":"Denied"}}}\n\n')]);
  await assert.rejects(collectResponse(source), /Denied/);
});

test("streaming Responses retain named events and their payloads", async () => {
  const response = { object: "response", status: "completed", output: [] };
  const terminal = { type: "response.completed", response };
  let written = "";
  const res = { setHeader() {}, write(chunk) { written += chunk; return true; }, end() { this.ended = true; } };
  await streamResponse(upstream([Buffer.from(`data: ${JSON.stringify(terminal)}\n\n`)]), res, "responses", null);
  assert.equal(written, `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`);
  assert.equal(res.ended, true);
});

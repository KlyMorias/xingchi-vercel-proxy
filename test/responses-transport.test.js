const test = require("node:test");
const assert = require("node:assert/strict");
const { collectResponse, streamResponse } = require("../lib/responses-transport");
const { createChatStream } = require("../lib/openai-compat");
const { createMessagesStream } = require("../lib/anthropic-compat");

function source(events, { keepOpen = true, stalledCancel = false } = {}) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      if (!keepOpen) controller.close();
    },
    cancel() { cancelled++; return stalledCancel ? new Promise(() => {}) : undefined; },
  });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    body, get cancelled() { return cancelled; } };
}

async function promptly(promise) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Transport waited for provider EOF or cancellation")), 750);
    })]);
  } finally { clearTimeout(timeout); }
}

function sink() {
  return { frames: [], headers: {}, ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    write(frame) { this.frames.push(frame); return true; },
    end() { this.ended = true; },
  };
}

function parsedFrames(res) {
  return res.frames.filter((frame) => !frame.includes("[DONE]")).map((frame) =>
    JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

const final = {
  id: "resp_finished", object: "response", status: "completed", model: "gpt-6.1-sol", created_at: 1795158900,
  output: [
    { type: "message", id: "msg_one", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Checking weather.", annotations: [] }] },
    { type: "function_call", id: "fc_one", call_id: "call_one", name: "weather", arguments: '{"city":"Baku"}', status: "completed" },
  ],
  usage: { input_tokens: 9, output_tokens: 8, total_tokens: 17,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
};

const events = [
  { type: "response.created", response: { ...final, status: "in_progress", output: [], usage: null } },
  { type: "response.output_text.delta", item_id: "msg_one", output_index: 0, content_index: 0, delta: "Checking " },
  { type: "response.output_text.delta", item_id: "msg_one", output_index: 0, content_index: 0, delta: "weather." },
  { type: "response.output_item.added", output_index: 1,
    item: { ...final.output[1], arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_one", output_index: 1, delta: '{"city":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_one", output_index: 1, delta: '"Baku"}' },
  { type: "response.completed", response: final },
];

test("JSON collection returns the validated terminal object without provider EOF or a settled cancellation", async () => {
  const upstream = source(events, { stalledCancel: true });
  assert.deepEqual(await promptly(collectResponse(upstream.response)), final);
  assert.equal(upstream.cancelled, 1);
  assert.equal(upstream.body.locked, false);
});

test("Responses stream ends on its terminal event and preserves the complete event payload", async () => {
  const upstream = source(events, { stalledCancel: true });
  const res = sink();
  await promptly(streamResponse(upstream.response, res, "responses", null));
  assert.deepEqual(parsedFrames(res), events);
  assert.equal(res.ended, true);
  assert.equal(upstream.cancelled, 1);
  assert.equal(upstream.body.locked, false);
});

test("Chat stream immediately finishes text, tool arguments, usage and DONE while provider remains open", async () => {
  const upstream = source(events);
  const res = sink();
  await promptly(streamResponse(upstream.response, res, "chat", createChatStream("gpt-6.1-sol", { includeUsage: true })));
  const chunks = parsedFrames(res);
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content || "").join(""), "Checking weather.");
  const toolParts = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls || []);
  assert.equal(toolParts[0].id, "call_one");
  assert.equal(toolParts.map((part) => part.function.arguments).join(""), '{"city":"Baku"}');
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls");
  assert.equal(chunks.at(-1).usage.total_tokens, 17);
  assert.equal(res.frames.at(-1), "data: [DONE]\n\n");
  assert.equal(res.ended, true);
  assert.equal(upstream.cancelled, 1);
});

test("Anthropic stream immediately completes text/tools and preserves final usage", async () => {
  const upstream = source(events);
  const res = sink();
  await promptly(streamResponse(upstream.response, res, "messages", createMessagesStream("gpt-6.1-sol")));
  const frames = parsedFrames(res);
  assert.equal(frames.filter((frame) => frame.type === "content_block_delta" && frame.delta.type === "text_delta")
    .map((frame) => frame.delta.text).join(""), "Checking weather.");
  assert.equal(frames.filter((frame) => frame.type === "content_block_delta" && frame.delta.type === "input_json_delta")
    .map((frame) => frame.delta.partial_json).join(""), '{"city":"Baku"}');
  const stop = frames.find((frame) => frame.type === "message_delta");
  assert.equal(stop.delta.stop_reason, "tool_use");
  assert.equal(stop.usage.output_tokens, 8);
  assert.equal(frames.at(-1).type, "message_stop");
  assert.equal(res.ended, true);
});

test("incomplete terminal response ends promptly while retaining partial output and length reason", async () => {
  const response = { ...final, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [final.output[0]] };
  const event = { type: "response.incomplete", response };
  assert.deepEqual(await promptly(collectResponse(source([event]).response)), response);
  const res = sink();
  await promptly(streamResponse(source([event]).response, res, "chat", createChatStream("gpt-6.1-sol")));
  const chunks = parsedFrames(res);
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content || "").join(""), "Checking weather.");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "length");
  assert.equal(res.ended, true);
});

test("missing or mismatched terminal status remains an error and never calls adapter finish", async () => {
  for (const response of [{ ...final, status: "in_progress" }, { ...final, status: "failed" },
    { ...final, status: "incomplete" }, { ...final, output: undefined }]) {
    const event = { type: "response.completed", response };
    await assert.rejects(collectResponse(source([event], { keepOpen: false }).response), { statusCode: 502 });
    let finishes = 0;
    const res = sink();
    await assert.rejects(streamResponse(source([event], { keepOpen: false }).response, res, "chat", {
      mapEvent() { return []; }, finish() { finishes++; return []; },
    }), { statusCode: 502 });
    assert.equal(finishes, 0);
    assert.equal(res.ended, false);
  }
  const partial = [{ type: "response.output_text.delta", delta: "partial" }];
  await assert.rejects(collectResponse(source(partial, { keepOpen: false }).response), { code: "incomplete_stream" });
  await assert.rejects(streamResponse(source(partial, { keepOpen: false }).response, sink(), "responses", null), { code: "incomplete_stream" });
});

test("a final response is authoritative even if a provider appends invalid trailing data", async () => {
  const upstream = source([{ type: "response.completed", response: final }, { type: "error", error: { message: "late" } }]);
  assert.deepEqual(await promptly(collectResponse(upstream.response)), final);
  const res = sink();
  await promptly(streamResponse(source([{ type: "response.completed", response: final }, { type: "error" }]).response, res, "responses", null));
  assert.equal(parsedFrames(res).length, 1);
  assert.equal(res.ended, true);
});

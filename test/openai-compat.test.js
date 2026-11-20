const test = require("node:test");
const assert = require("node:assert/strict");
const { chatRequestToResponses, chatCompletionFromResponse, createChatStream } = require("../lib/openai-compat.js");

const base = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hello" }] };
const textResponse = {
  id: "resp_123", created_at: 1795158900, model: "gpt-6.1-sol", status: "completed",
  output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant",
    content: [{ type: "output_text", text: "Hello", annotations: [] }, { type: "output_text", text: " world", annotations: [] }] }],
  usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } },
};

test("maps instructions, image content and generation controls to Responses", () => {
  const request = chatRequestToResponses({ ...base, messages: [
    { role: "system", content: "Be concise." },
    { role: "developer", content: [{ type: "text", text: "Use Turkish." }] },
    { role: "user", content: [{ type: "text", text: "Describe this." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] },
    { role: "assistant", content: "A small image." },
  ], max_completion_tokens: 200, reasoning_effort: "low", temperature: 0.4, top_p: 0.8, parallel_tool_calls: false });
  assert.equal(request.instructions, "Be concise.\n\nUse Turkish.");
  assert.deepEqual(request.input[0], { type: "message", role: "user", content: [
    { type: "input_text", text: "Describe this." },
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
  ] });
  assert.equal(request.input[1].role, "assistant");
  assert.equal(request.max_output_tokens, 200);
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.temperature, 0.4);
  assert.equal(request.top_p, 0.8);
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.equal(chatRequestToResponses(base).temperature, undefined);
});

test("preserves function call IDs and tool results across a multi-turn request", () => {
  const converted = chatRequestToResponses({ ...base, messages: [
    { role: "user", content: "Weather?" },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"Baku"}' } },
    ] },
    { role: "tool", tool_call_id: "call_weather", content: '{"temperature":18}' },
  ], tools: [{ type: "function", function: { name: "weather", description: "Read weather",
    parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  tool_choice: { type: "function", function: { name: "weather" } } });
  assert.deepEqual(converted.input[1], { type: "function_call", call_id: "call_weather", name: "weather", arguments: '{"city":"Baku"}' });
  assert.deepEqual(converted.input[2], { type: "function_call_output", call_id: "call_weather", output: '{"temperature":18}' });
  assert.deepEqual(converted.tools[0], { type: "function", name: "weather", description: "Read weather",
    parameters: { type: "object", properties: { city: { type: "string" } } }, strict: false });
  assert.deepEqual(converted.tool_choice, { type: "function", name: "weather" });
});

test("flattens structured JSON format without silently changing strictness", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const converted = chatRequestToResponses({ ...base, response_format: {
    type: "json_schema", json_schema: { name: "Answer", schema, strict: true },
  }, max_tokens: 90, stream: false });
  assert.deepEqual(converted.text, { format: { type: "json_schema", name: "Answer", schema, strict: true } });
  assert.equal(converted.max_output_tokens, 90);
  assert.deepEqual(chatRequestToResponses({ ...base, response_format: { type: "json_object" } }).text,
    { format: { type: "json_object" } });
});

test("rejects unsupported choices, audio, legacy fields and invalid shapes with 400", () => {
  const rejected = [
    { ...base, n: 2 }, { ...base, stop: "END" }, { ...base, audio: { voice: "alloy" } },
    { ...base, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA", format: "wav" } }] }] },
    { ...base, messages: [{ role: "user", content: { text: "wrong" } }] },
    { ...base, messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] },
    { ...base, messages: [{ role: "tool", content: "result" }] },
    { ...base, tools: [{ type: "web_search" }] },
    { ...base, max_tokens: 10, max_completion_tokens: 20 },
    { ...base, stream_options: { unknown_option: true } },
    { ...base, temperature: "0.5" }, { ...base, parallel_tool_calls: "true" },
  ];
  for (const request of rejected) assert.throws(() => chatRequestToResponses(request), { status: 400 });
});

test("constructs a complete Chat response with text, refusal and token details", () => {
  const response = chatCompletionFromResponse(textResponse, "gpt-6.1-sol");
  assert.equal(response.object, "chat.completion");
  assert.equal(response.id, "chatcmpl_resp_123");
  assert.equal(response.created, 1795158900);
  assert.deepEqual(response.choices[0].message, { role: "assistant", content: "Hello world", refusal: null });
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.deepEqual(response.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } });
  const refused = chatCompletionFromResponse({ ...textResponse,
    output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot help." }] }] });
  assert.equal(refused.choices[0].message.refusal, "Cannot help.");
  assert.equal(refused.choices[0].message.content, null);
});

test("maps tool responses and max-output termination to correct finish reasons", () => {
  const response = chatCompletionFromResponse({ ...textResponse, output: [
    { type: "function_call", id: "fc_internal", call_id: "call_1", name: "weather", arguments: '{"city":"Baku"}' },
  ] });
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(response.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Baku"}' } },
  ]);
  assert.equal(chatCompletionFromResponse({ ...textResponse, status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" } }).choices[0].finish_reason, "length");
  assert.throws(() => chatCompletionFromResponse({ ...textResponse, status: "failed" }), { status: 502 });
});

test("streams interleaved text and parallel function arguments with stable Chat tool indexes", () => {
  const adapter = createChatStream("gpt-6.1-sol", { includeUsage: true });
  const events = [
    { type: "response.created", response: { id: "resp_stream", created_at: 1795158900 } },
    { type: "response.output_text.delta", output_index: 1, delta: "Checking. " },
    { type: "response.output_item.added", output_index: 2,
      item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "weather", arguments: "" } },
    { type: "response.output_item.added", output_index: 3,
      item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "time", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 2, delta: '{"city":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 3, delta: "{}" },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 2, delta: '"Baku"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_b", output_index: 3, arguments: "{}" },
    { type: "response.completed", response: { ...textResponse, id: "resp_stream", output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "Checking. " }] },
      { type: "function_call", id: "fc_a", call_id: "call_a", name: "weather", arguments: '{"city":"Baku"}' },
      { type: "function_call", id: "fc_b", call_id: "call_b", name: "time", arguments: "{}" },
    ] } },
  ];
  const chunks = events.flatMap((event) => adapter.mapEvent(event));
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(chunks[1].choices[0].delta.content, "Checking. ");
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].id, "call_a");
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].index, 1);
  const argumentsByIndex = ["", ""];
  for (const chunk of chunks) {
    assert.equal(chunk.id, "chatcmpl_resp_stream");
    for (const call of chunk.choices[0]?.delta.tool_calls || []) argumentsByIndex[call.index] += call.function.arguments || "";
  }
  assert.deepEqual(argumentsByIndex, ['{"city":"Baku"}', "{}"]);
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage.total_tokens, 28);
  assert.deepEqual(adapter.finish(), []);
});

test("finishes incomplete streams as length and omits unsolicited usage chunks", () => {
  const adapter = createChatStream("gpt-6.1-sol");
  adapter.mapEvent({ type: "response.created", response: { id: "resp_short" } });
  adapter.mapEvent({ type: "response.output_text.delta", output_index: 1, delta: "Partial" });
  const chunks = adapter.mapEvent({ type: "response.incomplete", response: { ...textResponse,
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [
      { type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "Partial" }] },
    ] } });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices[0].finish_reason, "length");
  assert.equal(chunks[0].usage, undefined);
  assert.deepEqual(adapter.finish(), []);
});

test("recovers final function arguments when an upstream sends only the done item", () => {
  const adapter = createChatStream("gpt-6.1-sol");
  const chunks = adapter.mapEvent({ type: "response.output_item.done", output_index: 2,
    item: { type: "function_call", id: "fc_one", call_id: "call_one", name: "weather", arguments: "{}" } });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "call_one");
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.arguments, "{}");
});

test("upstream failure, unmatched function deltas and truncated streams never become success", () => {
  assert.throws(() => createChatStream("gpt-6.1-sol").mapEvent({ type: "response.failed", response: { status: "failed" } }), { status: 502 });
  assert.throws(() => createChatStream("gpt-6.1-sol").mapEvent({ type: "error", message: "failure" }), { status: 502 });
  assert.throws(() => createChatStream("gpt-6.1-sol").mapEvent({ type: "response.function_call_arguments.delta", item_id: "missing", delta: "{}" }), { status: 502 });
  const truncated = createChatStream("gpt-6.1-sol");
  truncated.mapEvent({ type: "response.output_text.delta", delta: "partial" });
  assert.throws(() => truncated.finish(), { status: 502 });
});

test("completion-only upstream responses recover all final text and function calls", () => {
  const adapter = createChatStream("gpt-6.1-sol");
  adapter.mapEvent({ type: "response.created", response: { id: "resp_json", created_at: 1795158900 } });
  const chunks = adapter.mapEvent({ type: "response.completed", response: { ...textResponse,
    output: [...textResponse.output, { type: "function_call", id: "fc_final", call_id: "call_final", name: "weather", arguments: "{}" }],
  } });
  const text = chunks.map((chunk) => chunk.choices[0]?.delta.content || "").join("");
  assert.equal(text, "Hello world");
  const calls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls || []);
  assert.equal(calls[0].id, "call_final");
  assert.equal(calls.map((call) => call.function.arguments || "").join(""), "{}");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("final output supplies only missing suffixes and late created does not duplicate role or ID", () => {
  const adapter = createChatStream("gpt-6.1-sol");
  const initial = adapter.mapEvent({ type: "response.output_text.delta", item_id: "msg_final", output_index: 0, delta: "Hel" });
  assert.deepEqual(adapter.mapEvent({ type: "response.created", response: { id: "resp_late" } }), []);
  const final = adapter.mapEvent({ type: "response.completed", response: { ...textResponse,
    output: [{ id: "msg_final", type: "message", content: [{ type: "output_text", text: "Hello" }] }],
  } });
  assert.equal(initial.length, 2);
  assert.equal(final[0].choices[0].delta.content, "lo");
  assert.equal(final[0].id, initial[0].id);
  assert.equal(final.filter((chunk) => chunk.choices[0]?.delta.role).length, 0);
});

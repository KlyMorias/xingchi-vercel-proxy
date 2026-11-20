"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { messagesRequestToResponses, messageFromResponse, createMessagesStream } = require("../lib/anthropic-compat");

const model = "gpt-6.1-sol";
const textItem = { id: "msg_output", type: "message", role: "assistant", content: [{ type: "output_text", text: "Merhaba!", annotations: [] }] };
const finalResponse = { id: "resp_123", status: "completed", model, output: [textItem], usage: { input_tokens: 17, output_tokens: 5 } };

test("converts system text, user images and a tool round trip without retaining reasoning", () => {
  const result = messagesRequestToResponses({ model, max_tokens: 300, stream: false, system: [{ type: "text", text: "Be helpful." }, { type: "text", text: "Use tools." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "What is here?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "secret" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "hello" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Found it." }] }, { type: "text", text: "Now answer." }] },
    ], tools: [{ name: "lookup", description: "Look something up", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
    tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
  });
  assert.equal(result.instructions, "Be helpful.\n\nUse tools.");
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.max_output_tokens, 300);
  assert.deepEqual(result.input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,aGk=" });
  assert.equal(result.input[1].content[0].type, "output_text");
  assert.deepEqual(result.input[2], { type: "function_call", call_id: "toolu_1", name: "lookup", arguments: '{"query":"hello"}' });
  assert.deepEqual(result.input[3], { type: "function_call_output", call_id: "toolu_1", output: "Found it." });
  assert.deepEqual(result.tool_choice, { type: "function", name: "lookup" });
  assert.equal(result.parallel_tool_calls, false);
  assert.deepEqual(result.tools[0].parameters, { type: "object", properties: { query: { type: "string" } } });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("maps tool choice variants and URL images", () => {
  for (const [type, translated] of [["auto", "auto"], ["any", "required"], ["none", "none"]]) {
    const result = messagesRequestToResponses({ model, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }] }], tool_choice: { type } });
    assert.equal(result.tool_choice, translated);
    assert.equal(result.input[0].content[0].image_url, "https://example.com/cat.png");
  }
});

test("rejects document blocks, malformed content and non-object tool input as 400", () => {
  for (const content of [[{ type: "document", source: { type: "base64", data: "aGk=" } }], [null], 42]) {
    assert.throws(() => messagesRequestToResponses({ model, messages: [{ role: "user", content }] }), (error) => error.statusCode === 400);
  }
  assert.throws(() => messagesRequestToResponses({ model, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: [] }] }] }), (error) => error.statusCode === 400);
});

test("converts a final response with token usage, tools and maximum-output stop reason", () => {
  const result = messageFromResponse({ ...finalResponse, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [
    { type: "reasoning", encrypted_content: "hidden", summary: [{ text: "not public" }] }, textItem,
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"hello"}' },
  ] }, model);
  assert.equal(result.id, "msg_123");
  assert.deepEqual(result.content, [{ type: "text", text: "Merhaba!" }, { type: "tool_use", id: "call_1", name: "lookup", input: { query: "hello" } }]);
  assert.equal(result.stop_reason, "max_tokens");
  assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 5 });
  assert.equal(result.stop_sequence, null);
  assert.equal(messageFromResponse({ ...finalResponse, output: [] }, model).stop_reason, "end_turn");
});

test("rejects upstream failures and invalid tool JSON as 502", () => {
  assert.throws(() => messageFromResponse({ status: "failed", error: { message: "private upstream failure" } }, model), (error) => error.statusCode === 502 && !error.message.includes("private"));
  for (const args of ["{broken", "[]", '"string"']) {
    assert.throws(() => messageFromResponse({ ...finalResponse, output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: args }] }, model), (error) => error.statusCode === 502);
  }
});

test("streams text once despite repeated Responses done/completed snapshots", () => {
  const mapper = createMessagesStream(model);
  const frames = [
    { type: "response.created", response: { ...finalResponse, output: [], usage: { input_tokens: 17, output_tokens: 0 } } },
    { type: "response.output_item.added", output_index: 0, item: { ...textItem, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Mer" },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "haba!" },
    { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Merhaba!" },
    { type: "response.content_part.done", output_index: 0, content_index: 0, part: textItem.content[0] },
    { type: "response.output_item.done", output_index: 0, item: textItem },
    { type: "response.completed", response: finalResponse },
  ].flatMap((event) => mapper.mapEvent(event));
  assert.equal(frames.filter((frame) => frame.event === "message_start").length, 1);
  assert.equal(frames.filter((frame) => frame.event === "content_block_start").length, 1);
  assert.equal(frames.filter((frame) => frame.event === "content_block_stop").length, 1);
  assert.equal(frames.filter((frame) => frame.event === "content_block_delta").map((frame) => frame.data.delta.text).join(""), "Merhaba!");
  assert.deepEqual(frames.find((frame) => frame.event === "message_delta").data.usage, { input_tokens: 17, output_tokens: 5 });
  assert.equal(frames.at(-1).event, "message_stop");
  assert.deepEqual(mapper.finish(), []);
});

test("streams function arguments once and closes with tool_use", () => {
  const mapper = createMessagesStream(model);
  const tool = { id: "fc_1", type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Baku"}' };
  const frames = [
    { type: "response.created", response: { id: "resp_tool", output: [] } },
    { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"city":' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '"Baku"}' },
    { type: "response.function_call_arguments.done", output_index: 1, arguments: tool.arguments },
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [{ type: "reasoning", encrypted_content: "secret" }, tool], usage: { input_tokens: 8, output_tokens: 10 } } },
  ].flatMap((event) => mapper.mapEvent(event));
  assert.equal(frames.filter((frame) => frame.event === "content_block_start").length, 1);
  assert.deepEqual(frames.find((frame) => frame.event === "content_block_start").data.content_block, { type: "tool_use", id: "call_1", name: "weather", input: {} });
  assert.equal(frames.filter((frame) => frame.event === "content_block_delta").map((frame) => frame.data.delta.partial_json).join(""), tool.arguments);
  assert.equal(frames.find((frame) => frame.event === "message_delta").data.delta.stop_reason, "tool_use");
  assert.equal(JSON.stringify(frames).includes("secret"), false);
});

test("supports completion-only and empty output streams without invented content", () => {
  const mapper = createMessagesStream(model);
  const frames = mapper.mapEvent({ type: "response.completed", response: finalResponse });
  assert.equal(frames.filter((frame) => frame.event === "content_block_delta")[0].data.delta.text, "Merhaba!");
  const empty = createMessagesStream(model);
  assert.deepEqual(empty.mapEvent({ type: "response.completed", response: { ...finalResponse, output: [] } }).map((frame) => frame.event), ["message_start", "message_delta", "message_stop"]);
});

test("throws for upstream error, truncated streams and incomplete tool JSON", () => {
  const mapper = createMessagesStream(model);
  assert.throws(() => mapper.mapEvent({ type: "response.failed", response: { status: "failed" } }), (error) => error.statusCode === 502);
  assert.throws(() => createMessagesStream(model).finish(), (error) => error.statusCode === 502);
  const malformed = createMessagesStream(model);
  malformed.mapEvent({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "x", arguments: "" } });
  assert.throws(() => malformed.mapEvent({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{bad" }), (error) => error.statusCode === 502);
});

test("marks an upstream output-token limit as max_tokens while retaining partial text", () => {
  const mapper = createMessagesStream(model);
  const frames = mapper.mapEvent({ type: "response.incomplete", response: { ...finalResponse, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
  assert.equal(frames.find((frame) => frame.event === "content_block_delta").data.delta.text, "Merhaba!");
  assert.equal(frames.find((frame) => frame.event === "message_delta").data.delta.stop_reason, "max_tokens");
  assert.deepEqual(mapper.finish(), []);
  assert.throws(() => messageFromResponse({ status: "completed", output: {} }, model), (error) => error.statusCode === 502);
});

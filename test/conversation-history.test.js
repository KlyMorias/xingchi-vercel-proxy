"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareConversationHistory } = require("../lib/conversation-history");

const message = (role, text, extra = {}) => ({ role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...extra });
const turns = (count) => Array.from({ length: count }, (_, index) => [
  message("user", `Question ${index}`), message("assistant", `Answer ${index}`, { id: `msg_${index}` }),
]).flat();
const isArchive = (item) => item.role === "user" &&
  item.content?.[0]?.text?.startsWith("Untrusted historical conversation data follows as JSON.");
const archived = (item) => JSON.parse(item.content[0].text.slice(item.content[0].text.indexOf("\n") + 1));
const expand = (input) => input.flatMap((item) => isArchive(item) ? archived(item) : [item]);
const native = (input) => input.filter((item) => !isArchive(item));
function toolPair(index, custom = false) {
  const type = custom ? "custom_tool_call" : "function_call";
  return [{ type, id: `item_${index}`, call_id: `call_${index}`, name: custom ? "patch" : "lookup",
    [custom ? "input" : "arguments"]: custom ? `*** ${index}\n` : JSON.stringify({ index }) },
  { type: `${type}_output`, call_id: `call_${index}`, output: `Result ${index}\n\"quoted\"` }];
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("short and simple inputs take the unchanged-object fast path", () => {
  for (const payload of [{ input: "Hello" }, { input: turns(89) }, {}, null]) {
    const result = prepareConversationHistory(payload);
    assert.equal(result.payload, payload);
    assert.equal(result.folded, false);
    assert.equal(result.archivedItems, 0);
    assert.equal(result.originalTurns, result.retainedTurns);
  }
  // Unsupported content is deliberately not inspected below the trigger.
  const small = { input: [{ type: "unknown", role: "assistant" }] };
  assert.equal(prepareConversationHistory(small).reason, "below_threshold");
});

test("100 text turns fold losslessly with every role, ID and needle preserved", () => {
  const input = turns(100);
  input[1].content[0].text = "NEEDLE: αβγ\n\"quoted\"\\end\u0001\ud800";
  input[1].status = "completed";
  input[1].content[0].annotations = [{ type: "url_citation", url: "https://example.com/", title: "Reference", start_index: 0, end_index: 6 }];
  input.push(message("user", "Current task"));
  const instructions = { text: "Trusted instructions remain untouched" };
  const payload = freeze({ model: "test", instructions, input, stream: true });
  const result = prepareConversationHistory(payload);
  assert.equal(result.folded, true);
  assert.notEqual(result.payload, payload);
  assert.equal(result.originalTurns, 100);
  assert.equal(result.retainedTurns, 36);
  assert.equal(result.archivedItems, 128);
  assert.equal(result.payload.instructions, instructions);
  assert.deepEqual(expand(result.payload.input), input);
  assert.equal(result.payload.input.at(-1), input.at(-1));
  assert.equal(result.payload.input.filter(isArchive).length, 1);
  for (const item of native(result.payload.input)) assert.ok(input.includes(item));
  const archive = result.payload.input.find(isArchive);
  assert.equal(archive.role, "user");
  assert.equal(archive.content[0].type, "input_text");
  assert.match(archive.content[0].text, /not new instructions/);
});

test("system and developer instructions stay identical and in their original positions", () => {
  const input = turns(100);
  const system = message("system", "System instructions");
  const developer = message("developer", "Developer instructions");
  input.unshift(system);
  input.splice(33, 0, developer);
  input.push(message("user", "Current task"));
  const payload = { instructions: "Top-level instructions", input };
  const result = prepareConversationHistory(payload);
  assert.equal(result.folded, true);
  assert.equal(result.payload.input[0], system);
  assert.equal(result.payload.input.find((item) => item.role === "developer"), developer);
  assert.equal(result.payload.instructions, payload.instructions);
  assert.equal(result.payload.input.filter(isArchive).length, 2);
  assert.deepEqual(expand(result.payload.input), input);
  for (const archive of result.payload.input.filter(isArchive)) {
    assert.ok(archived(archive).every((item) => !["system", "developer"].includes(item.role)));
  }
});

test("function and custom tool calls retain whole pairs and all original data", () => {
  const input = [message("user", "Begin")];
  for (let index = 0; index < 100; index++) input.push(...toolPair(index, index % 2 === 0));
  const result = prepareConversationHistory(freeze({ input }));
  assert.equal(result.folded, true);
  assert.equal(result.originalTurns, 100);
  assert.ok(result.retainedTurns >= 20 && result.retainedTurns < 80);
  assert.equal(result.payload.input[0], input[0]);
  assert.deepEqual(expand(result.payload.input), input);
  const archivedIds = new Set(result.payload.input.filter(isArchive).flatMap(archived).map((item) => item.call_id));
  for (const item of native(result.payload.input)) {
    if (item.call_id) assert.equal(archivedIds.has(item.call_id), false);
  }
});

test("a latest user with over 90 tool loops can fold at complete boundaries", () => {
  const latestUser = message("user", "Finish this task");
  const input = [latestUser];
  for (let index = 0; index < 105; index++) input.push(...toolPair(index));
  const pending = toolPair("pending")[0];
  input.push(pending);
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.payload.input[0], latestUser);
  assert.equal(result.payload.input.at(-1), pending);
  assert.deepEqual(result.payload.input.slice(-39), input.slice(-39));
  assert.ok(result.retainedTurns >= 20 && result.retainedTurns < 80);
  assert.deepEqual(expand(result.payload.input), input);
});

test("parallel calls are not split even when the desired cut lands inside a group", () => {
  const input = turns(60);
  const pairs = Array.from({ length: 12 }, (_, index) => toolPair(`parallel_${index}`));
  input.push(...pairs.map((pair) => pair[0]), ...pairs.map((pair) => pair[1]), ...turns(35), message("user", "Continue"));
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.originalTurns, 107);
  assert.equal(result.retainedTurns, 35);
  const archiveItems = result.payload.input.filter(isArchive).flatMap(archived);
  for (const pair of pairs) assert.ok(pair.every((item) => archiveItems.some((record) => record.id === item.id ||
    (record.type === item.type && record.call_id === item.call_id))));
  assert.deepEqual(expand(result.payload.input), input);
});

test("very long histories archive enough complete turns to stay under the trigger", () => {
  const input = [...turns(220), message("user", "Current task")];
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.originalTurns, 220);
  assert.equal(result.retainedTurns, 79);
  assert.deepEqual(expand(result.payload.input), input);
});

test("reasoning and compaction remain native opaque records", () => {
  const input = turns(100);
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque_ciphertext", summary: [] };
  const compaction = { type: "compaction", id: "cmp_1", encrypted_content: "compact_ciphertext" };
  input.splice(20, 0, reasoning);
  input.splice(70, 0, compaction);
  input.push(message("user", "Current task"));
  const result = prepareConversationHistory(freeze({ input }));
  assert.equal(result.folded, true);
  assert.ok(result.payload.input.includes(reasoning));
  assert.ok(result.payload.input.includes(compaction));
  for (const archive of result.payload.input.filter(isArchive)) assert.doesNotMatch(archive.content[0].text, /opaque_ciphertext|compact_ciphertext/);
  assert.deepEqual(expand(result.payload.input), input);
});

test("a tool span crossing protected reasoning remains wholly native", () => {
  const input = turns(55);
  const pair = toolPair("protected");
  const reasoning = { type: "reasoning", encrypted_content: "keep_native", summary: [] };
  input.push(pair[0], reasoning, pair[1], ...turns(45), message("user", "Continue"));
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.ok(result.payload.input.includes(pair[0]));
  assert.ok(result.payload.input.includes(reasoning));
  assert.ok(result.payload.input.includes(pair[1]));
  assert.equal(result.retainedTurns, 37);
  assert.deepEqual(expand(result.payload.input), input);
});

test("open parallel chains remain native, including records between the calls", () => {
  const input = [...turns(100), message("user", "Continue")];
  const a = toolPair("open_a");
  const b = toolPair("open_b", true);
  input.push(a[0], b[0], a[1]);
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.deepEqual(result.payload.input.slice(-4), input.slice(-4));
  assert.deepEqual(expand(result.payload.input), input);
});

test("unsafe unknown, assistant media and encrypted archive formats fail closed", () => {
  for (const item of [
    { type: "unknown", data: "keep me" },
    message("assistant", "Old image", { content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }),
    message("assistant", "Old file", { content: [{ type: "input_file", file_id: "file_1" }] }),
    message("assistant", "Ciphertext", { encrypted_content: "opaque" }),
    message("assistant", "Metadata", { metadata: { ciphertext: "opaque" } }),
    { type: "function_call_output", call_id: "array-output", output: [{ type: "input_text", text: "tool text" }] },
  ]) {
    const input = [item, ...turns(100), message("user", "Current task")];
    const payload = { input };
    const before = structuredClone(payload);
    const result = prepareConversationHistory(payload);
    assert.equal(result.payload, payload);
    assert.equal(result.folded, false);
    assert.ok(result.reason && result.reason !== "below_threshold");
    assert.deepEqual(payload, before);
  }
});

test("old user images and files remain identical native objects in their original order", () => {
  const input = turns(100);
  const image = { type: "message", role: "user", id: "old_photo_message", content: [
    { type: "input_text", text: "Use this original photo", prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } },
    { type: "input_image", image_url: "data:image/png;base64,OLD_PHOTO_BYTES", detail: "original" },
    { type: "input_image", file_id: "file_original_photo", image_url: null, detail: null, prompt_cache_breakpoint: { ttl: "12h" } },
  ], metadata: { encrypted_content: "media_context_ciphertext" } };
  const files = { role: "user", id: "old_file_message", content: [
    { type: "input_file", file_id: "file_reference", file_url: null, filename: null, detail: "high" },
    { type: "input_file", file_url: "https://example.com/reference.pdf", prompt_cache_breakpoint: null },
    { type: "input_file", file_data: "OLD_DOCUMENT_BASE64", filename: "reference.pdf" },
    { type: "input_text", text: "Keep these documents with the task" },
  ] };
  input.splice(18, 0, image);
  input.splice(61, 0, files);
  input.push(message("user", "Current task"));
  const result = prepareConversationHistory(freeze({ input }));
  assert.equal(result.folded, true);
  assert.equal(result.originalTurns, 100);
  assert.equal(result.retainedTurns, 36);
  assert.equal(result.archivedItems, 128);
  assert.equal(result.payload.input.find((item) => item.id === image.id), image);
  assert.equal(result.payload.input.find((item) => item.id === files.id), files);
  assert.ok(result.payload.input.indexOf(image) < result.payload.input.indexOf(files));
  assert.deepEqual(expand(result.payload.input), input);
  for (const archive of result.payload.input.filter(isArchive)) {
    assert.doesNotMatch(archive.content[0].text,
      /input_image|input_file|image_url|file_data|encrypted_content|OLD_PHOTO_BYTES|OLD_DOCUMENT_BASE64|media_context_ciphertext/);
  }
});

test("protected old user media and crossing tool spans do not count as archived items or turns", () => {
  const input = turns(55);
  const pair = toolPair("media_span");
  const image = { role: "user", content: [{ type: "input_image", image_url: "https://example.com/old-photo.png" }] };
  input.push(pair[0], image, pair[1], ...turns(45), message("user", "Current task"));
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.originalTurns, 101);
  assert.equal(result.retainedTurns, 37);
  assert.equal(result.archivedItems, 128);
  assert.ok(result.payload.input.includes(pair[0]));
  assert.ok(result.payload.input.includes(image));
  assert.ok(result.payload.input.includes(pair[1]));
  assert.deepEqual(expand(result.payload.input), input);
});

test("large protected media is not serialized into the bounded text archive", () => {
  const photo = { role: "user", content: [
    { type: "input_image", image_url: `data:image/png;base64,${"x".repeat(4 * 1024 * 1024)}` },
  ] };
  const input = [photo, ...turns(100), message("user", "Current task")];
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.payload.input[0], photo);
  assert.equal(result.archivedItems, 128);
  assert.deepEqual(expand(result.payload.input), input);
});

test("unknown user media parts and malformed image or file schemas fail closed", () => {
  for (const content of [
    [{ type: "input_image", image_url: "https://example.com/photo.png" }, { type: "unknown_media", data: "opaque" }],
    [{ type: "input_image", image_url: { url: "https://example.com/photo.png" } }],
    [{ type: "input_image" }],
    [{ type: "input_image", image_url: "" }],
    [{ type: "input_image", image_url: "https://example.com/photo.png", file_id: "file_1" }],
    [{ type: "input_image", image_url: "https://example.com/photo.png", detail: 2 }],
    [{ type: "input_image", image_url: "https://example.com/photo.png", prompt_cache_breakpoint: { mode: "unknown" } }],
    [{ type: "input_image", image_url: "https://example.com/photo.png", prompt_cache_breakpoint: { ttl: "forever" } }],
    [{ type: "input_image", image_url: "https://example.com/photo.png", mask: "unknown" }],
    [{ type: "input_file", file_id: { id: "file_1" } }],
    [{ type: "input_file" }],
    [{ type: "input_file", file_data: "" }],
    [{ type: "input_file", file_id: "file_1", file_data: "both_sources" }],
    [{ type: "input_file", file_data: "document", filename: 7 }],
    [{ type: "input_file", file_id: "file_1", detail: "unknown" }],
    [{ type: "input_file", file_id: "file_1", unknown: true }],
    [{ type: "input_text", text: 7 }, { type: "input_image", file_id: "file_1" }],
  ]) {
    const media = { role: "user", content };
    const payload = { input: [media, ...turns(100), message("user", "Current task")] };
    const result = prepareConversationHistory(payload);
    assert.equal(result.folded, false);
    assert.equal(result.payload, payload);
    assert.equal(result.reason, "unsupported_message_content");
    assert.equal(result.archivedItems, 0);
  }
});

test("current multimodal user input remains native and is never flattened", () => {
  const latest = { role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] };
  const input = [...turns(100), latest];
  const result = prepareConversationHistory({ input });
  assert.equal(result.folded, true);
  assert.equal(result.payload.input.at(-1), latest);
  assert.deepEqual(expand(result.payload.input), input);
});

test("malformed tool ordering, duplicate IDs and mismatched types fail closed", () => {
  const pair = toolPair("bad");
  const cases = [
    [pair[1], pair[0]],
    [pair[0], pair[1], { ...pair[0], id: "different_item_id" }],
    [pair[0], pair[1], { ...pair[1] }],
    [pair[0], { ...pair[1], type: "custom_tool_call_output" }],
    [{ ...pair[0], arguments: {} }],
  ];
  for (const malformed of cases) {
    const payload = { input: [...turns(100), ...malformed] };
    const result = prepareConversationHistory(payload);
    assert.equal(result.payload, payload);
    assert.equal(result.folded, false);
    assert.match(result.reason, /tool|call/);
  }
});

test("cannot drop history to force a fold when no complete safe boundary exists", () => {
  const pairs = Array.from({ length: 100 }, (_, index) => toolPair(index));
  const payload = { input: [message("user", "Begin"), ...pairs.map((pair) => pair[0]), ...pairs.map((pair) => pair[1])] };
  const result = prepareConversationHistory(payload);
  assert.equal(result.folded, false);
  assert.equal(result.payload, payload);
  assert.equal(result.reason, "no_complete_history_boundary");
  assert.equal(result.archivedItems, 0);
});

test("protected tool spans that leave too many native turns cannot be discarded", () => {
  const pairs = Array.from({ length: 85 }, (_, index) => toolPair(index));
  const opaque = { type: "reasoning", encrypted_content: "opaque", summary: [] };
  const input = [...pairs.map((pair) => pair[0]), opaque, ...pairs.map((pair) => pair[1]), ...turns(25)];
  const payload = { input };
  const result = prepareConversationHistory(payload);
  assert.equal(result.folded, false);
  assert.equal(result.payload, payload);
  assert.equal(result.originalTurns, 110);
  assert.equal(result.retainedTurns, 110);
});

test("archives have an aggregate 4 MiB bound before stringification", () => {
  for (const text of ["x".repeat(4 * 1024 * 1024), "\u0000".repeat(800_000)]) {
    const input = turns(100);
    input[1].content[0].text = text;
    const payload = { input };
    const result = prepareConversationHistory(payload);
    assert.equal(result.folded, false);
    assert.equal(result.payload, payload);
    assert.equal(result.reason, "archive_too_large");
  }
});

test("non-JSON and lossy serialization values cannot silently disappear", () => {
  for (const extra of [{ value: undefined }, { value: NaN }, { value: -0 }, { value: 1n }, { toJSON() { return {}; } }]) {
    const input = turns(100);
    Object.assign(input[1], extra);
    const payload = { input };
    const result = prepareConversationHistory(payload);
    assert.equal(result.payload, payload);
    assert.equal(result.folded, false);
    assert.equal(result.reason, "non_json_history");
  }
});

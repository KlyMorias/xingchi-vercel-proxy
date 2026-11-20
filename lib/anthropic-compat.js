"use strict";

const crypto = require("node:crypto");

function adapterError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.length) throw adapterError(400, `${label} must be a non-empty string`);
  return value;
}

function stringContent(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw adapterError(400, `${label} must be text or an array of text blocks`);
  return value.map((block) => {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") {
      throw adapterError(400, `${label} supports text blocks only`);
    }
    return block.text;
  }).join("\n\n");
}

function imageContent(block) {
  const source = block.source;
  if (!isObject(source)) throw adapterError(400, "An image source is required");
  if (source.type === "base64") {
    if (!/^image\/(?:jpeg|png|webp|gif)$/.test(source.media_type || "") ||
      typeof source.data !== "string" || !source.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
      throw adapterError(400, "Image content must contain supported media_type and base64 data");
    }
    return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
  }
  if (source.type === "url") {
    let url;
    try { url = new URL(source.url); } catch { throw adapterError(400, "Image URL is invalid"); }
    if (!["https:", "http:"].includes(url.protocol)) throw adapterError(400, "Image URL must use HTTP or HTTPS");
    return { type: "input_image", image_url: url.href };
  }
  throw adapterError(400, "Only base64 and URL image sources are supported");
}

function userContent(block) {
  if (block.type === "text" && typeof block.text === "string") return { type: "input_text", text: block.text };
  if (block.type === "image") return imageContent(block);
  throw adapterError(400, `Unsupported user content block: ${block.type || "unknown"}`);
}

function toolResultContent(block) {
  if (typeof block.content === "string") return block.is_error ? `Error: ${block.content}` : block.content;
  if (block.content === undefined) return block.is_error ? "Error" : "";
  if (!Array.isArray(block.content)) throw adapterError(400, "Tool result content must be text or an array of content blocks");
  const output = block.content.map((part) => {
    if (!isObject(part)) throw adapterError(400, "Tool result content must contain objects");
    return userContent(part);
  });
  if (output.every((part) => part.type === "input_text")) {
    const text = output.map((part) => part.text).join("\n");
    return block.is_error ? `Error: ${text}` : text;
  }
  if (block.is_error) output.unshift({ type: "input_text", text: "Tool execution failed." });
  return output;
}

function messagesRequestToResponses(payload) {
  if (!isObject(payload)) throw adapterError(400, "A Messages request object is required");
  if (!Array.isArray(payload.messages) || !payload.messages.length) throw adapterError(400, "messages must be a non-empty array");
  const converted = {
    model: requireString(payload.model, "model"),
    input: [],
    stream: true,
    store: false,
  };
  if (payload.max_tokens !== undefined) {
    if (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1) throw adapterError(400, "max_tokens must be a positive integer");
    converted.max_output_tokens = payload.max_tokens;
  }
  if (payload.system !== undefined) converted.instructions = stringContent(payload.system, "system");
  if (payload.stop_sequences !== undefined && (!Array.isArray(payload.stop_sequences) || payload.stop_sequences.length)) {
    throw adapterError(400, "Custom stop_sequences are not supported by this Responses adapter");
  }

  for (const message of payload.messages) {
    if (!isObject(message) || !["user", "assistant"].includes(message.role)) throw adapterError(400, "Messages roles must be user or assistant");
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw adapterError(400, "Message content must be text or an array of blocks");
    let content = [];
    const flush = () => {
      if (!content.length) return;
      if (message.role === "assistant") {
        converted.input.push({ type: "message", role: "assistant", content });
      } else {
        converted.input.push({ role: "user", content });
      }
      content = [];
    };
    for (const block of blocks) {
      if (!isObject(block)) throw adapterError(400, "Message content blocks must be objects");
      if (message.role === "assistant") {
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "output_text", text: block.text, annotations: [] });
        } else if (block.type === "tool_use") {
          flush();
          const input = block.input === undefined ? {} : block.input;
          if (!isObject(input)) throw adapterError(400, "Tool use input must be a JSON object");
          let args;
          try { args = JSON.stringify(input); } catch { throw adapterError(400, "Tool use input must be valid JSON"); }
          converted.input.push({ type: "function_call", call_id: requireString(block.id, "tool_use.id"), name: requireString(block.name, "tool_use.name"), arguments: args });
        } else {
          throw adapterError(400, `Unsupported assistant content block: ${block.type || "unknown"}`);
        }
      } else if (block.type === "tool_result") {
        flush();
        converted.input.push({ type: "function_call_output", call_id: requireString(block.tool_use_id, "tool_result.tool_use_id"), output: toolResultContent(block) });
      } else {
        content.push(userContent(block));
      }
    }
    flush();
  }

  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools)) throw adapterError(400, "tools must be an array");
    converted.tools = payload.tools.map((tool) => {
      if (!isObject(tool) || (tool.type !== undefined && tool.type !== "custom") || !isObject(tool.input_schema)) {
        throw adapterError(400, "Only custom tools with an input_schema object are supported");
      }
      const result = { type: "function", name: requireString(tool.name, "tool.name"), parameters: tool.input_schema };
      if (tool.description !== undefined) {
        if (typeof tool.description !== "string") throw adapterError(400, "Tool description must be text");
        result.description = tool.description;
      }
      return result;
    });
  }
  if (payload.tool_choice !== undefined) {
    const choice = payload.tool_choice;
    if (!isObject(choice)) throw adapterError(400, "tool_choice must be an object");
    if (choice.type === "auto") converted.tool_choice = "auto";
    else if (choice.type === "any") converted.tool_choice = "required";
    else if (choice.type === "none") converted.tool_choice = "none";
    else if (choice.type === "tool") converted.tool_choice = { type: "function", name: requireString(choice.name, "tool_choice.name") };
    else throw adapterError(400, "Unsupported tool_choice type");
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== "boolean") throw adapterError(400, "disable_parallel_tool_use must be a boolean");
      converted.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
  }
  return converted;
}

function usageFrom(response) {
  const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  return { input_tokens: nonnegative(response?.usage?.input_tokens), output_tokens: nonnegative(response?.usage?.output_tokens) };
}

function messageId(id) {
  return typeof id === "string" && id ? `msg_${id.replace(/^(?:resp_|msg_)/, "")}` : `msg_${crypto.randomBytes(12).toString("hex")}`;
}

function assertResponse(response) {
  if (!isObject(response)) throw adapterError(502, "The upstream response is not a valid response object");
  if (response.output !== undefined && !Array.isArray(response.output)) throw adapterError(502, "The upstream output must be an array");
  if (response.error || (response.status !== undefined && !["completed", "incomplete"].includes(response.status))) {
    throw adapterError(502, "The upstream model did not complete the response");
  }
  if (response.status === "incomplete" && response.incomplete_details?.reason !== "max_output_tokens") {
    throw adapterError(502, "The upstream model returned an incomplete response");
  }
}

function toolInput(argumentsText) {
  let input;
  try { input = JSON.parse(argumentsText || "{}"); } catch { throw adapterError(502, "The upstream model returned invalid tool arguments"); }
  if (!isObject(input)) throw adapterError(502, "The upstream model returned non-object tool arguments");
  return input;
}

function stopReason(response, hasTools) {
  if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return hasTools ? "tool_use" : "end_turn";
}

function messageFromResponse(response, model) {
  assertResponse(response);
  const content = [];
  for (const item of response.output || []) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      if (!Array.isArray(item.content)) throw adapterError(502, "The upstream message content must be an array");
      for (const part of item.content || []) {
        if (!isObject(part)) throw adapterError(502, "The upstream message contains an invalid content block");
        if (part.type === "output_text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part.type === "refusal" && typeof part.refusal === "string") content.push({ type: "text", text: part.refusal });
      }
    } else if (item.type === "function_call") {
      if (typeof item.name !== "string" || !item.name || typeof item.call_id !== "string" || !item.call_id) throw adapterError(502, "The upstream tool call is missing its name or ID");
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input: toolInput(item.arguments) });
    }
  }
  return {
    id: messageId(response.id), type: "message", role: "assistant", model: model || response.model,
    content, stop_reason: stopReason(response, content.some((part) => part.type === "tool_use")),
    stop_sequence: null, usage: usageFrom(response),
  };
}

function createMessagesStream(model) {
  let started = false;
  let completed = false;
  let nextBlock = 0;
  const blocks = new Map();
  const pendingToolDeltas = new Map();
  const itemIndexes = new Map();
  let id = messageId();

  const frame = (event, payload) => ({ event, data: { type: event, ...payload } });
  function ensureStart(frames, response) {
    if (started) return;
    if (response?.id) id = messageId(response.id);
    frames.push(frame("message_start", { message: { id, type: "message", role: "assistant", content: [], model: model || response?.model,
      stop_reason: null, stop_sequence: null, usage: { ...usageFrom(response), output_tokens: 0 } } }));
    started = true;
  }
  function outputIndex(event) {
    if (Number.isSafeInteger(event.output_index) && event.output_index >= 0) {
      const itemId = event.item_id || event.item?.id;
      if (itemId) itemIndexes.set(itemId, event.output_index);
      return event.output_index;
    }
    const itemId = event.item_id || event.item?.id;
    if (itemId && itemIndexes.has(itemId)) return itemIndexes.get(itemId);
    return 0;
  }
  function textBlock(frames, itemIndex, contentIndex) {
    const key = `text:${itemIndex}:${contentIndex}`;
    if (!blocks.has(key)) {
      const block = { type: "text", index: nextBlock++, text: "", closed: false };
      blocks.set(key, block);
      frames.push(frame("content_block_start", { index: block.index, content_block: { type: "text", text: "" } }));
    }
    return blocks.get(key);
  }
  function addText(frames, block, delta) {
    if (block.closed || !delta) return;
    block.text += delta;
    frames.push(frame("content_block_delta", { index: block.index, delta: { type: "text_delta", text: delta } }));
  }
  function reconcileText(frames, block, fullText) {
    if (typeof fullText !== "string") return;
    if (!fullText.startsWith(block.text)) throw adapterError(502, "The upstream text stream is inconsistent");
    addText(frames, block, fullText.slice(block.text.length));
  }
  function close(frames, block) {
    if (block.closed) return;
    if (block.type === "tool_use") toolInput(block.arguments);
    frames.push(frame("content_block_stop", { index: block.index }));
    block.closed = true;
  }
  function addArguments(frames, block, delta) {
    if (block.closed || !delta) return;
    block.arguments += delta;
    frames.push(frame("content_block_delta", { index: block.index, delta: { type: "input_json_delta", partial_json: delta } }));
  }
  function reconcileArguments(frames, block, fullArguments) {
    if (typeof fullArguments !== "string") return;
    if (!fullArguments.startsWith(block.arguments)) throw adapterError(502, "The upstream tool argument stream is inconsistent");
    addArguments(frames, block, fullArguments.slice(block.arguments.length));
  }
  function toolBlock(frames, itemIndex, item) {
    const key = `tool:${itemIndex}`;
    if (!blocks.has(key)) {
      if (!item || typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) {
        throw adapterError(502, "The upstream tool call is missing its name or ID");
      }
      const block = { type: "tool_use", index: nextBlock++, arguments: "", closed: false };
      blocks.set(key, block);
      frames.push(frame("content_block_start", { index: block.index, content_block: { type: "tool_use", id: item.call_id, name: item.name, input: {} } }));
      const pending = pendingToolDeltas.get(itemIndex);
      if (pending) addArguments(frames, block, pending);
      pendingToolDeltas.delete(itemIndex);
    }
    return blocks.get(key);
  }
  function completeItem(frames, item, itemIndex) {
    if (!isObject(item)) throw adapterError(502, "The upstream output contains an invalid item");
    if (item.type === "function_call") {
      const block = toolBlock(frames, itemIndex, item);
      reconcileArguments(frames, block, item.arguments);
      close(frames, block);
    } else if (item.type === "message") {
      if (!Array.isArray(item.content)) throw adapterError(502, "The upstream message content must be an array");
      (item.content || []).forEach((part, contentIndex) => {
        if (!isObject(part)) throw adapterError(502, "The upstream message contains an invalid content block");
        const fullText = part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : undefined;
        if (typeof fullText !== "string") return;
        const block = textBlock(frames, itemIndex, contentIndex);
        reconcileText(frames, block, fullText);
        close(frames, block);
      });
    }
  }

  function mapEvent(event) {
    if (completed) return [];
    if (!isObject(event) || typeof event.type !== "string") return [];
    if (["response.failed", "response.cancelled", "error"].includes(event.type)) throw adapterError(502, "The upstream model request failed");
    const frames = [];
    if (event.type === "response.created" || event.type === "response.in_progress") {
      ensureStart(frames, event.response);
      return frames;
    }
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      const response = event.response;
      assertResponse(response);
      ensureStart(frames, response);
      (response.output || []).forEach((item, itemIndex) => completeItem(frames, item, itemIndex));
      if (pendingToolDeltas.size) throw adapterError(502, "The upstream stream ended without tool call metadata");
      for (const block of blocks.values()) close(frames, block);
      frames.push(frame("message_delta", { delta: { stop_reason: stopReason(response, [...blocks.values()].some((block) => block.type === "tool_use")), stop_sequence: null }, usage: usageFrom(response) }));
      frames.push(frame("message_stop", {}));
      completed = true;
      return frames;
    }
    if (!event.type.startsWith("response.")) return [];
    const itemIndex = outputIndex(event);
    const contentIndex = Number.isSafeInteger(event.content_index) ? event.content_index : 0;
    if (event.type === "response.output_item.added") {
      if (event.item?.type === "function_call") {
        ensureStart(frames);
        const block = toolBlock(frames, itemIndex, event.item);
        reconcileArguments(frames, block, event.item.arguments);
      }
    } else if (event.type === "response.content_part.added") {
      if (event.part?.type === "output_text" || event.part?.type === "refusal") {
        ensureStart(frames);
        const block = textBlock(frames, itemIndex, contentIndex);
        reconcileText(frames, block, event.part.text ?? event.part.refusal);
      }
    } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (typeof event.delta !== "string") throw adapterError(502, "The upstream text delta is invalid");
      ensureStart(frames);
      addText(frames, textBlock(frames, itemIndex, contentIndex), event.delta);
    } else if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
      ensureStart(frames);
      const block = textBlock(frames, itemIndex, contentIndex);
      reconcileText(frames, block, event.text ?? event.refusal);
      close(frames, block);
    } else if (event.type === "response.content_part.done") {
      if (event.part?.type === "output_text" || event.part?.type === "refusal") {
        ensureStart(frames);
        const block = textBlock(frames, itemIndex, contentIndex);
        reconcileText(frames, block, event.part.text ?? event.part.refusal);
        close(frames, block);
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (typeof event.delta !== "string") throw adapterError(502, "The upstream tool argument delta is invalid");
      const block = blocks.get(`tool:${itemIndex}`);
      if (block) addArguments(frames, block, event.delta);
      else pendingToolDeltas.set(itemIndex, (pendingToolDeltas.get(itemIndex) || "") + event.delta);
    } else if (event.type === "response.function_call_arguments.done") {
      const block = blocks.get(`tool:${itemIndex}`);
      if (block) {
        reconcileArguments(frames, block, event.arguments);
        close(frames, block);
      } else if (typeof event.arguments === "string") {
        pendingToolDeltas.set(itemIndex, event.arguments);
      }
    } else if (event.type === "response.output_item.done" && isObject(event.item)) {
      if (["function_call", "message"].includes(event.item.type)) {
        ensureStart(frames);
        completeItem(frames, event.item, itemIndex);
      }
    }
    return frames;
  }

  return {
    mapEvent,
    finish() {
      if (!completed) throw adapterError(502, "The upstream event stream ended before response completion");
      return [];
    },
  };
}

module.exports = { messagesRequestToResponses, messageFromResponse, createMessagesStream };

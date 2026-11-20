const crypto = require("node:crypto");

function fail(message, status = 400, param) {
  return Object.assign(new Error(message), { status, statusCode: status,
    type: status === 400 ? "invalid_request_error" : "upstream_error",
    code: status === 400 ? "unsupported_request" : "invalid_upstream_response", ...(param ? { param } : {}) });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${label} must be an object.`, 400, label);
  return value;
}

function fields(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw fail(`Unsupported ${label} field: ${key}.`, 400, `${label}.${key}`);
  }
}

function text(value, label) {
  if (typeof value !== "string") throw fail(`${label} must be a string.`, 400, label);
  return value;
}

function name(value, label) {
  text(value, label);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw fail(`${label} must be a valid function name.`, 400, label);
  return value;
}

function content(value, label, textOnly = false) {
  if (typeof value === "string") return [{ type: "input_text", text: value }];
  if (!Array.isArray(value)) throw fail(`${label} must be text or a content array.`, 400, label);
  return value.map((part, index) => {
    const path = `${label}[${index}]`;
    object(part, path);
    if (part.type === "text") {
      fields(part, ["type", "text"], path);
      return { type: "input_text", text: text(part.text, `${path}.text`) };
    }
    if (part.type === "image_url" && !textOnly) {
      fields(part, ["type", "image_url"], path);
      fields(part.image_url, ["url", "detail"], `${path}.image_url`);
      const url = text(part.image_url.url, `${path}.image_url.url`);
      if (!/^https?:\/\//i.test(url) && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
        throw fail("Image inputs require an HTTP(S) URL or base64 image data URL.", 400, path);
      }
      const detail = part.image_url.detail || "auto";
      if (!["auto", "low", "high"].includes(detail)) throw fail("Unsupported image detail.", 400, path);
      return { type: "input_image", image_url: url, detail };
    }
    throw fail(`Unsupported content type: ${part.type || "missing"}.`, 400, path);
  });
}

function chatRequestToResponses(payload) {
  fields(payload, ["model", "messages", "tools", "tool_choice", "response_format", "max_tokens",
    "max_completion_tokens", "reasoning_effort", "temperature", "top_p", "parallel_tool_calls",
    "stream", "stream_options", "n"], "request");
  if (payload.n !== undefined && payload.n !== 1) throw fail("Only n=1 is supported.", 400, "n");
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") throw fail("stream must be boolean.", 400, "stream");
  if (payload.stream_options !== undefined) {
    fields(payload.stream_options, ["include_usage"], "stream_options");
    if (payload.stream_options.include_usage !== undefined && typeof payload.stream_options.include_usage !== "boolean") {
      throw fail("stream_options.include_usage must be boolean.", 400, "stream_options.include_usage");
    }
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) throw fail("messages must be a nonempty array.", 400, "messages");
  const converted = { input: [], stream: true, store: false };
  if (payload.model !== undefined) converted.model = text(payload.model, "model");
  const instructions = [];
  payload.messages.forEach((message, index) => {
    const path = `messages[${index}]`;
    fields(message, ["role", "content", "tool_calls", "tool_call_id"], path);
    if (["system", "developer"].includes(message.role)) {
      if (message.tool_calls !== undefined || message.tool_call_id !== undefined) throw fail("Instruction messages cannot contain tool calls.", 400, path);
      instructions.push(content(message.content, `${path}.content`, true).map((part) => part.text).join("\n"));
      return;
    }
    if (message.role === "tool") {
      if (message.tool_calls !== undefined) throw fail("Tool output cannot contain tool_calls.", 400, path);
      const callId = text(message.tool_call_id, `${path}.tool_call_id`);
      if (!callId) throw fail("tool_call_id cannot be empty.", 400, path);
      converted.input.push({ type: "function_call_output", call_id: callId,
        output: typeof message.content === "string" ? message.content : content(message.content, `${path}.content`) });
      return;
    }
    if (!["user", "assistant"].includes(message.role)) throw fail(`Unsupported message role: ${message.role}.`, 400, path);
    if (message.tool_call_id !== undefined || (message.role === "user" && message.tool_calls !== undefined)) {
      throw fail("Tool-call fields are only supported on assistant/tool messages.", 400, path);
    }
    if (message.content !== null && message.content !== undefined) {
      converted.input.push({ type: "message", role: message.role, content: content(message.content, `${path}.content`) });
    } else if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      throw fail("Message content is required without tool calls.", 400, path);
    }
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls)) throw fail("tool_calls must be an array.", 400, path);
      for (const call of message.tool_calls) {
        fields(call, ["id", "type", "function"], `${path}.tool_calls`);
        if (call.type !== "function") throw fail("Only function tool calls are supported.", 400, path);
        fields(call.function, ["name", "arguments"], `${path}.tool_calls.function`);
        converted.input.push({ type: "function_call", call_id: text(call.id, `${path}.tool_calls.id`),
          name: name(call.function.name, `${path}.tool_calls.function.name`),
          arguments: text(call.function.arguments, `${path}.tool_calls.function.arguments`) });
      }
    }
  });
  if (instructions.length) converted.instructions = instructions.join("\n\n");
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools)) throw fail("tools must be an array.", 400, "tools");
    converted.tools = payload.tools.map((tool) => {
      fields(tool, ["type", "function"], "tools");
      if (tool.type !== "function") throw fail("Only function tools are supported.", 400, "tools");
      fields(tool.function, ["name", "description", "parameters", "strict"], "tools.function");
      const fn = tool.function;
      const mapped = { type: "function", name: name(fn.name, "tools.function.name"), strict: fn.strict ?? false };
      if (typeof mapped.strict !== "boolean") throw fail("Tool strict must be boolean.", 400, "tools.function.strict");
      if (fn.description !== undefined) mapped.description = text(fn.description, "tools.function.description");
      if (fn.parameters !== undefined) mapped.parameters = object(fn.parameters, "tools.function.parameters");
      return mapped;
    });
  }
  if (payload.tool_choice !== undefined) {
    if (typeof payload.tool_choice === "string") {
      if (!["auto", "none", "required"].includes(payload.tool_choice)) throw fail("Unsupported tool_choice.", 400, "tool_choice");
      converted.tool_choice = payload.tool_choice;
    } else {
      fields(payload.tool_choice, ["type", "function"], "tool_choice");
      fields(payload.tool_choice.function, ["name"], "tool_choice.function");
      if (payload.tool_choice.type !== "function") throw fail("Unsupported tool_choice.", 400, "tool_choice");
      converted.tool_choice = { type: "function", name: name(payload.tool_choice.function.name, "tool_choice.function.name") };
    }
  }
  if (payload.response_format !== undefined) {
    const format = payload.response_format;
    fields(format, ["type", "json_schema"], "response_format");
    if (["text", "json_object"].includes(format.type)) {
      if (format.json_schema !== undefined) throw fail("json_schema requires type=json_schema.", 400, "response_format");
      converted.text = { format: { type: format.type } };
    } else if (format.type === "json_schema") {
      fields(format.json_schema, ["name", "schema", "strict", "description"], "response_format.json_schema");
      const schema = format.json_schema;
      const mapped = { type: "json_schema", name: text(schema.name, "response_format.json_schema.name"),
        schema: object(schema.schema, "response_format.json_schema.schema"), strict: schema.strict ?? false };
      if (typeof mapped.strict !== "boolean") throw fail("Schema strict must be boolean.", 400, "response_format.json_schema.strict");
      if (schema.description !== undefined) mapped.description = text(schema.description, "response_format.json_schema.description");
      converted.text = { format: mapped };
    } else throw fail("Unsupported response_format.", 400, "response_format");
  }
  const maxTokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (payload.max_completion_tokens !== undefined && payload.max_tokens !== undefined && payload.max_completion_tokens !== payload.max_tokens) {
    throw fail("Conflicting output token limits.", 400, "max_tokens");
  }
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw fail("Token limit must be a positive integer.", 400, "max_completion_tokens");
    converted.max_output_tokens = maxTokens;
  }
  if (payload.reasoning_effort !== undefined) {
    if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(payload.reasoning_effort)) throw fail("Unsupported reasoning_effort.", 400, "reasoning_effort");
    converted.reasoning = { effort: payload.reasoning_effort };
  }
  for (const parameter of ["temperature", "top_p"]) {
    if (payload[parameter] !== undefined) {
      const value = payload[parameter];
      if (!Number.isFinite(value) || value < 0 || value > (parameter === "temperature" ? 2 : 1)) throw fail(`Invalid ${parameter}.`, 400, parameter);
      converted[parameter] = value;
    }
  }
  if (payload.parallel_tool_calls !== undefined) {
    if (typeof payload.parallel_tool_calls !== "boolean") throw fail("parallel_tool_calls must be boolean.", 400, "parallel_tool_calls");
    converted.parallel_tool_calls = payload.parallel_tool_calls;
  }
  return converted;
}

function usageFromResponse(usage) {
  if (!usage) return undefined;
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) throw fail("Invalid upstream token usage.", 502);
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    ...(usage.input_tokens_details ? { prompt_tokens_details: { ...usage.input_tokens_details } } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: { ...usage.output_tokens_details } } : {}) };
}

function finishReason(response, hasTools) {
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") return "length";
    if (response.incomplete_details?.reason === "content_filter") return "content_filter";
    throw fail("Upstream response ended incomplete without a supported reason.", 502);
  }
  if (response.status !== "completed") throw fail("Upstream response did not complete successfully.", 502);
  return hasTools ? "tool_calls" : "stop";
}

function completionId(id) { return `chatcmpl_${id || crypto.randomBytes(12).toString("hex")}`; }

function chatCompletionFromResponse(response, model) {
  if (!response || !Array.isArray(response.output)) throw fail("Invalid upstream response output.", 502);
  const parts = [];
  const refusals = [];
  const calls = [];
  for (const item of response.output) {
    if (item.type === "message") {
      if (!Array.isArray(item.content)) throw fail("Invalid upstream message content.", 502);
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
        else if (part.type === "refusal" && typeof part.refusal === "string") refusals.push(part.refusal);
        else throw fail(`Unsupported upstream output content: ${part.type}.`, 502);
      }
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") throw fail("Invalid upstream function call.", 502);
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    } else if (item.type !== "reasoning") throw fail(`Unsupported upstream output item: ${item.type}.`, 502);
  }
  const message = { role: "assistant", content: parts.length ? parts.join("") : null, refusal: refusals.length ? refusals.join("") : null };
  if (calls.length) message.tool_calls = calls;
  const usage = usageFromResponse(response.usage);
  return { id: completionId(response.id), object: "chat.completion", created: response.created_at || Math.floor(Date.now() / 1000),
    model: model || response.model, choices: [{ index: 0, message, finish_reason: finishReason(response, calls.length > 0), logprobs: null }],
    ...(usage ? { usage } : {}) };
}

function createChatStream(model, { includeUsage = false } = {}) {
  let id = completionId();
  let created = Math.floor(Date.now() / 1000);
  let started = false;
  let ended = false;
  const calls = new Map();
  const visible = new Map();
  function chunk(delta, finish_reason = null) {
    return { id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...(includeUsage ? { usage: null } : {}) };
  }
  function start() {
    if (started) return [];
    started = true;
    return [chunk({ role: "assistant", content: "" })];
  }
  function toolAdded(item, outputIndex) {
    if (typeof item.call_id !== "string" || typeof item.name !== "string") throw fail("Invalid streamed function call.", 502);
    const key = item.id || `index:${outputIndex}`;
    if (calls.has(key) || [...calls.values()].some((call) => call.id === item.call_id)) return [];
    const call = { index: calls.size, id: item.call_id, name: item.name, arguments: "", key, outputIndex };
    calls.set(key, call);
    const emitted = [chunk({ tool_calls: [{ index: call.index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] })];
    if (item.arguments) emitted.push(...argumentsDone(call, item.arguments));
    return emitted;
  }
  function findCall(event) {
    return calls.get(event.item_id) || [...calls.values()].find((call) => call.outputIndex === event.output_index);
  }
  function argumentsDone(call, argumentsText) {
    if (!call || typeof argumentsText !== "string" || !argumentsText.startsWith(call.arguments)) throw fail("Invalid streamed function arguments.", 502);
    const suffix = argumentsText.slice(call.arguments.length);
    call.arguments = argumentsText;
    return suffix ? [chunk({ tool_calls: [{ index: call.index, function: { arguments: suffix } }] })] : [];
  }
  function visiblePart(kind, itemId, outputIndex, contentIndex) {
    const byItem = itemId ? `${kind}:item:${itemId}:${contentIndex ?? 0}` : null;
    const byIndex = `${kind}:index:${outputIndex ?? 0}:${contentIndex ?? 0}`;
    let part = (byItem && visible.get(byItem)) || visible.get(byIndex);
    if (!part) part = { value: "" };
    visible.set(byIndex, part);
    if (byItem) visible.set(byItem, part);
    return part;
  }
  function textDone(kind, fullText, itemId, outputIndex, contentIndex) {
    if (typeof fullText !== "string") throw fail("Invalid final streamed text.", 502);
    const part = visiblePart(kind, itemId, outputIndex, contentIndex);
    if (!fullText.startsWith(part.value)) throw fail("Final upstream text does not match its streamed deltas.", 502);
    const suffix = fullText.slice(part.value.length);
    part.value = fullText;
    return suffix ? [chunk({ [kind]: suffix })] : [];
  }
  function finalOutput(response) {
    if (!Array.isArray(response.output)) throw fail("Final upstream response has no output array.", 502);
    const emitted = [];
    response.output.forEach((item, outputIndex) => {
      if (item.type === "function_call") {
        emitted.push(...toolAdded(item, outputIndex));
        const call = [...calls.values()].find((entry) => entry.id === item.call_id);
        emitted.push(...argumentsDone(call, item.arguments));
      } else if (item.type === "message") {
        if (!Array.isArray(item.content)) throw fail("Invalid final upstream message.", 502);
        item.content.forEach((part, contentIndex) => {
          if (part.type === "output_text") emitted.push(...textDone("content", part.text, item.id, outputIndex, contentIndex));
          else if (part.type === "refusal") emitted.push(...textDone("refusal", part.refusal, item.id, outputIndex, contentIndex));
          else throw fail(`Unsupported upstream output content: ${part.type}.`, 502);
        });
      } else if (item.type !== "reasoning") throw fail(`Unsupported upstream output item: ${item.type}.`, 502);
    });
    return emitted;
  }
  return {
    mapEvent(event) {
      if (!event || typeof event.type !== "string") throw fail("Invalid upstream stream event.", 502);
      if (["error", "response.failed", "response.error"].includes(event.type)) throw fail("Upstream response stream failed.", 502);
      if (ended) throw fail("Received upstream data after response completion.", 502);
      if (event.type === "response.created") {
        // Some compatible providers deliver this after their first delta.
        // Keep the already emitted Chat ID/metadata stable and avoid a second role.
        if (started) return [];
        id = completionId(event.response?.id);
        created = event.response?.created_at || created;
        model = model || event.response?.model;
        return start();
      }
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        if (typeof event.delta !== "string") throw fail("Invalid streamed text delta.", 502);
        const kind = event.type === "response.refusal.delta" ? "refusal" : "content";
        visiblePart(kind, event.item_id, event.output_index, event.content_index).value += event.delta;
        return [...start(), chunk({ [kind]: event.delta })];
      }
      if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
        const kind = event.type === "response.refusal.done" ? "refusal" : "content";
        return [...start(), ...textDone(kind, kind === "content" ? event.text : event.refusal,
          event.item_id, event.output_index, event.content_index)];
      }
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        return [...start(), ...toolAdded(event.item, event.output_index)];
      }
      if (event.type === "response.function_call_arguments.delta") {
        const call = findCall(event);
        if (!call || typeof event.delta !== "string") throw fail("Function delta has no matching call.", 502);
        call.arguments += event.delta;
        return [chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta } }] })];
      }
      if (event.type === "response.function_call_arguments.done") return argumentsDone(findCall(event), event.arguments);
      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const emitted = [...start(), ...toolAdded(event.item, event.output_index)];
        const call = calls.get(event.item.id) || [...calls.values()].find((entry) => entry.outputIndex === event.output_index);
        return [...emitted, ...argumentsDone(call, event.item.arguments)];
      }
      if (["response.completed", "response.incomplete"].includes(event.type)) {
        const response = event.response;
        if (!response) throw fail("Missing final upstream response.", 502);
        const emitted = [...start(), ...finalOutput(response), chunk({}, finishReason(response, calls.size > 0))];
        const usage = usageFromResponse(response.usage);
        if (includeUsage && usage) emitted.push({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
        ended = true;
        return emitted;
      }
      // Lifecycle, reasoning and annotation events have no Chat Completions
      // delta equivalent; visible text/function arguments are handled above.
      return [];
    },
    finish() {
      if (!ended) throw fail("Upstream stream ended before its terminal response event.", 502);
      return [];
    },
  };
}

module.exports = { chatRequestToResponses, chatCompletionFromResponse, createChatStream };

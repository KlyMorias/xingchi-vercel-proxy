function transportError(message, code = "invalid_upstream_response") {
  return Object.assign(new Error(message), { statusCode: 502, code });
}
const TERMINAL_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);

async function providerFailure(event, onTerminal) {
  if (["error", "response.error", "response.failed", "response.cancelled"].includes(event.type)) {
    if (event.response?.object === "response" && TERMINAL_STATUSES.has(event.response.status)) {
      await onTerminal?.(event.response);
    }
    throw transportError("Upstream generation failed", "upstream_generation_failed");
  }
}

async function* eventsFrom(body) {
  if (!body) throw transportError("Upstream response body is missing");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function parse(block) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return null;
    try { return JSON.parse(data); } catch { throw transportError("Invalid upstream event", "invalid_event"); }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        if (separator.index > 8_000_000) throw transportError("Upstream event is too large");
        const event = parse(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (event) yield event;
      }
      if (buffer.length > 8_000_000) throw transportError("Upstream event is too large");
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parse(buffer);
      if (event) yield event;
    }
  } finally {
    // Providers may leave the connection open after a terminal event, and an
    // underlying cancel hook may itself never settle. Start cleanup without
    // delaying delivery of an already complete response.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Cancellation is best effort. */ }
    reader.releaseLock();
  }
}

function validateResponse(response, expectedStatus) {
  if (!response || response.object !== "response" || !Array.isArray(response.output)) {
    throw transportError("Upstream returned an invalid Responses object");
  }
  if (["failed", "cancelled"].includes(response.status) || response.error) {
    throw transportError("Upstream generation failed", "upstream_generation_failed");
  }
  if (!["completed", "incomplete"].includes(response.status) || (expectedStatus && response.status !== expectedStatus)) {
    throw transportError("Upstream returned a response without a matching terminal status");
  }
  return response;
}

async function terminalResponse(response, expectedStatus, onTerminal, prepare) {
  // Validate and prepare presentation before the accounting mutation, while
  // still reporting real consumption on a failed/malformed terminal. This
  // lets the same atomic settlement record the truthful outcome as well.
  let presentationError;
  try {
    validateResponse(response, expectedStatus);
    prepare?.(response);
  } catch (error) { presentationError = error; }
  if (response?.object === "response" && TERMINAL_STATUSES.has(response.status)) {
    await onTerminal?.(response, { presentationError });
  }
  if (presentationError) throw presentationError;
  return response;
}

async function collectResponse(upstream, { onTerminal, validateTerminal } = {}) {
  if (!(upstream.headers.get("content-type") || "").includes("text/event-stream")) {
    return terminalResponse(await upstream.json(), undefined, onTerminal, validateTerminal);
  }
  for await (const event of eventsFrom(upstream.body)) {
    await providerFailure(event, onTerminal);
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      return terminalResponse(event.response, event.type === "response.completed" ? "completed" : "incomplete", onTerminal, validateTerminal);
    }
  }
  throw transportError("Upstream stream ended before generation completed", "incomplete_stream");
}

async function writeFrame(res, frame) {
  if (res.destroyed) throw transportError("Client disconnected");
  if (!res.write(frame)) {
    await new Promise((resolve, reject) => {
      const clear = () => { res.off?.("drain", drained); res.off?.("close", closed); };
      const drained = () => { clear(); resolve(); };
      const closed = () => { clear(); reject(transportError("Client disconnected")); };
      res.once("drain", drained);
      res.once("close", closed);
    });
  }
}

function frameFor(value, format) {
  if (format === "messages") return `event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`;
  if (format === "responses") return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function streamResponse(upstream, res, format, adapter, { onComplete, onTerminal } = {}) {
  if (!res.headersSent) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
  }
  let completed = false;
  let finishFrames = [];
  let notified = false;
  const notify = async (response) => {
    if (notified || !onComplete) return;
    await onComplete(response);
    notified = true;
  };
  const send = async (event) => {
    await providerFailure(event, onTerminal);
    let frames;
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      await terminalResponse(event.response, event.type === "response.completed" ? "completed" : "incomplete", onTerminal, () => {
        // Adapter state advances exactly once. Buffer its terminal frames until
        // verified usage and the known presentation outcome are persisted.
        frames = adapter ? adapter.mapEvent(event) : [event];
        finishFrames = adapter ? adapter.finish() : [];
      });
      await notify(event.response);
      completed = true;
    }
    frames ??= adapter ? adapter.mapEvent(event) : [event];
    for (const frame of frames) await writeFrame(res, frameFor(frame, format));
  };
  if ((upstream.headers.get("content-type") || "").includes("text/event-stream")) {
    for await (const event of eventsFrom(upstream.body)) {
      await send(event);
      if (completed) break;
    }
  } else {
    const response = await upstream.json();
    let frames;
    await terminalResponse(response, undefined, onTerminal, () => {
      const created = { type: "response.created", response };
      const terminal = { type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response };
      frames = adapter ? [...adapter.mapEvent(created), ...adapter.mapEvent(terminal)] : [created, terminal];
      finishFrames = adapter ? adapter.finish() : [];
    });
    // The full generation is already known. Account for it before a client
    // disconnect can prevent delivery of the synthetic stream frames.
    await notify(response);
    completed = true;
    for (const frame of frames) await writeFrame(res, frameFor(frame, format));
  }
  if (!completed) throw transportError("Upstream stream ended before generation completed", "incomplete_stream");
  for (const frame of finishFrames) await writeFrame(res, frameFor(frame, format));
  if (format === "chat") await writeFrame(res, "data: [DONE]\n\n");
  res.end();
}

module.exports = { collectResponse, streamResponse, eventsFrom };

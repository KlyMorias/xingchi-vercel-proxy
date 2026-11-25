function transportError(message, code = "invalid_upstream_response") {
  return Object.assign(new Error(message), { statusCode: 502, code });
}

function providerFailure(event) {
  if (event.type === "error" || event.type === "response.failed") {
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
  if (response.status === "failed" || response.error) {
    throw transportError(response.error?.message || "Upstream generation failed");
  }
  if (!["completed", "incomplete"].includes(response.status) || (expectedStatus && response.status !== expectedStatus)) {
    throw transportError("Upstream returned a response without a matching terminal status");
  }
  return response;
}

async function collectResponse(upstream) {
  if (!(upstream.headers.get("content-type") || "").includes("text/event-stream")) {
    return validateResponse(await upstream.json());
  }
  for await (const event of eventsFrom(upstream.body)) {
    providerFailure(event);
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      return validateResponse(event.response, event.type === "response.completed" ? "completed" : "incomplete");
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

async function streamResponse(upstream, res, format, adapter, { onComplete } = {}) {
  if (!res.headersSent) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
  }
  let completed = false;
  let notified = false;
  const notify = async (response) => {
    if (notified || !onComplete) return;
    await onComplete(response);
    notified = true;
  };
  const send = async (event) => {
    providerFailure(event);
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      validateResponse(event.response, event.type === "response.completed" ? "completed" : "incomplete");
      await notify(event.response);
      completed = true;
    }
    const frames = adapter ? adapter.mapEvent(event) : [event];
    for (const frame of frames) await writeFrame(res, frameFor(frame, format));
  };
  if ((upstream.headers.get("content-type") || "").includes("text/event-stream")) {
    for await (const event of eventsFrom(upstream.body)) {
      await send(event);
      if (completed) break;
    }
  } else {
    const response = validateResponse(await upstream.json());
    // The full generation is already known. Account for it before a client
    // disconnect can prevent delivery of the synthetic stream frames.
    await notify(response);
    await send({ type: "response.created", response });
    await send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
  }
  if (!completed) throw transportError("Upstream stream ended before generation completed", "incomplete_stream");
  if (adapter) for (const frame of adapter.finish()) await writeFrame(res, frameFor(frame, format));
  if (format === "chat") await writeFrame(res, "data: [DONE]\n\n");
  res.end();
}

module.exports = { collectResponse, streamResponse, eventsFrom };

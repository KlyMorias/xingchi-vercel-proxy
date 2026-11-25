const MAX_ERROR_BODY_BYTES = 64 * 1024;

function withBody(response, body, headers = response.headers) {
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Inspection owns the reader after an overflow. Replay one chunk per pull so a
// slow/cancelled downstream never causes us to drain an arbitrarily large error.
function replay(chunks, reader, failure) {
  let index = 0;
  let released = false;
  const release = () => {
    if (!released) { released = true; reader.releaseLock(); }
  };
  return new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        chunks[index++] = undefined;
        controller.enqueue(chunk);
        return;
      }
      if (failure) {
        controller.error(failure.error);
        release();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); release(); }
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel(reason) {
      chunks.length = 0;
      try { await reader.cancel(reason); }
      finally { release(); }
    },
  }, { highWaterMark: 0 });
}

async function normalizeProviderError(response) {
  const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (response.status !== 400 || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mediaType)
    || !response.body || response.bodyUsed || response.body.locked) return response;

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      chunks.push(value);
      length += value.byteLength;
      // Retain the entire crossing chunk, without concatenating or parsing it.
      // The remainder stays unread until the returned body is consumed.
      if (length > MAX_ERROR_BODY_BYTES) return withBody(response, replay(chunks, reader));
    }
  } catch (error) {
    // Keep the prefix and original stream failure visible to the downstream.
    return withBody(response, replay(chunks, reader, { error }));
  }
  reader.releaseLock();

  const bytes = Buffer.concat(chunks, length);
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return withBody(response, bytes); }
  if (payload?.error?.code !== "session_turn_limit_exceeded") return withBody(response, bytes);

  const headers = new Headers(response.headers);
  // These describe the old representation and must not accompany new JSON.
  for (const name of ["content-length", "content-encoding", "content-md5", "digest", "etag"]) headers.delete(name);
  headers.set("content-type", "application/json; charset=utf-8");
  return withBody(response, JSON.stringify({ error: {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    param: "input",
    message: "This conversation has reached the provider's conversation limit. Run /compact to reduce its history, or /new to start a new conversation, then retry.",
  } }), headers);
}

module.exports = { normalizeProviderError, MAX_ERROR_BODY_BYTES };

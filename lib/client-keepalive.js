function startKeepalive(res, { stream = false, intervalMs = 8000 } = {}) {
  let started = false;
  let stopped = false;
  let waitingForDrain = false;
  let timer;
  const expectedType = stream ? "text/event-stream" : "application/json";

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    res.off?.("close", stop);
    res.off?.("finish", stop);
    res.off?.("drain", drained);
  }

  function drained() { waitingForDrain = false; }

  function tick() {
    if (stopped || res.destroyed || res.writableEnded) { stop(); return; }
    if (waitingForDrain) return;
    try {
      if (!res.headersSent) {
        res.statusCode = 200;
        res.setHeader("content-type", `${expectedType}; charset=utf-8`);
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("x-accel-buffering", "no");
      } else {
        const contentType = res.getHeader?.("content-type");
        if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== expectedType) {
          stop();
          return;
        }
      }
      started = true;
      if (!res.write(stream ? ": keep-alive\n\n" : "\n ")) {
        waitingForDrain = true;
        res.once?.("drain", drained);
      }
    } catch { stop(); }
  }

  res.once?.("close", stop);
  res.once?.("finish", stop);
  timer = setInterval(tick, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 8000);
  timer.unref?.();
  return { get started() { return started; }, stop };
}

module.exports = { startKeepalive };

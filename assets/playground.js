(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KlyPlayground = api;
})(typeof window === "object" ? window : globalThis, function playgroundModule() {
  "use strict";

  const MODEL_IDS = Object.freeze(["gpt-6.1-sol", "gpt-6-astra"]);
  const MODEL_NAMES = Object.freeze({ "gpt-6.1-sol": "GPT 6.1 Sol", "gpt-6-astra": "GPT 6 Astra" });
  const MAX_EVENT_LENGTH = 2_000_000;
  const MAX_RESPONSE_LENGTH = 8_000_000;
  const TIMEOUT_MS = 120_000;
  const keyPattern = /^kly_[A-Za-z0-9_-]{43}$/;

  function fail(message, code = "invalid_response") {
    return Object.assign(new Error(message), { code });
  }

  function safeMessage(message) {
    return String(message || "API isteği tamamlanamadı.").slice(0, 800)
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|kly_[A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/g, "[anahtar gizlendi]");
  }

  function apiError(value, status) {
    const detail = typeof value?.error === "string" ? value.error
      : value?.error?.message || value?.message;
    const prefix = status ? `HTTP ${status} · ` : "";
    if (detail) return fail(prefix + safeMessage(detail), "api_error");
    const generic = status === 401 ? "API anahtarı geçersiz veya iptal edilmiş."
      : status === 403 ? "Sağlayıcı bu isteğe izin vermedi."
        : status === 413 ? "İstek gövdesi çok büyük. Daha kısa bir istemle tekrar dene."
          : status === 429 ? "Kullanım sınırına ulaşıldı. Kotanın yenilenmesini bekle."
            : status >= 500 ? "API şu anda yanıt veremiyor. Biraz sonra yeniden dene."
              : "API isteği tamamlanamadı.";
    return fail(prefix + generic, "api_error");
  }

  function validateInput({ key, model, prompt, maxOutputTokens }, offeredModels = MODEL_IDS) {
    if (typeof key !== "string" || !keyPattern.test(key)) {
      throw fail("Panelden oluşturduğun kişisel kly_ anahtarını kullan. Kaynak sağlayıcı anahtarını buraya girme.", "invalid_key");
    }
    if (!MODEL_IDS.includes(model) || !offeredModels.includes(model)) {
      throw fail("Katalogdan kullanılabilir bir model seç.", "invalid_model");
    }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8000) {
      throw fail("İstem 1–8000 karakter olmalı.", "invalid_prompt");
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4096) {
      throw fail("Çıktı sınırı 64–4096 arasında bir tam sayı olmalı.", "invalid_limit");
    }
    return { model, input: prompt.trim(), max_output_tokens: maxOutputTokens, stream: true, store: false };
  }

  // Incremental SSE line parsing keeps split UTF-8 characters and CRLF pairs
  // intact. The caller decides which Responses events are meaningful.
  function createSseParser(onEvent) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let data = [];
    let eventName = "";
    let blockLength = 0;
    let closed = false;
    let halted = false;
    function dispatch() {
      const raw = data.join("\n");
      data = [];
      blockLength = 0;
      const name = eventName;
      eventName = "";
      if (!raw || raw === "[DONE]") return;
      let event;
      try { event = JSON.parse(raw); }
      catch { throw fail("API akışında geçersiz bir olay alındı.", "invalid_event"); }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw fail("API akışında geçersiz bir olay alındı.", "invalid_event");
      }
      if (onEvent(event.type || !name ? event : { ...event, type: name }) === false) halted = true;
    }
    function line(value) {
      if (!value) { dispatch(); return; }
      if (value.startsWith(":")) return;
      const colon = value.indexOf(":");
      const field = colon < 0 ? value : value.slice(0, colon);
      let text = colon < 0 ? "" : value.slice(colon + 1);
      if (text.startsWith(" ")) text = text.slice(1);
      if (field === "data") {
        blockLength += text.length;
        if (blockLength > MAX_EVENT_LENGTH) throw fail("API olayı görüntülenemeyecek kadar büyük.", "response_too_large");
        data.push(text);
      } else if (field === "event") eventName = text;
    }
    function drain(final) {
      while (!halted) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!final && index === buffer.length - 1 && buffer[index] === "\r")) break;
        const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + width);
      }
      if (halted) { buffer = ""; return; }
      if (buffer.length > MAX_EVENT_LENGTH) throw fail("API olayı görüntülenemeyecek kadar büyük.", "response_too_large");
      if (final) {
        if (buffer) line(buffer);
        buffer = "";
        if (data.length) dispatch();
      }
    }
    return {
      push(chunk) {
        if (halted) return;
        if (closed) throw fail("Akış ayrıştırıcısı zaten kapalı.", "parser_closed");
        try { buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }); }
        catch { throw fail("API akışı geçerli UTF-8 içermiyor.", "invalid_event"); }
        drain(false);
      },
      end() {
        if (closed) return;
        closed = true;
        try { buffer += decoder.decode(); }
        catch { throw fail("API akışı yarım bir UTF-8 karakteriyle kesildi.", "invalid_event"); }
        drain(true);
      },
    };
  }

  function responseText(response) {
    return response.output.filter((item) => item?.type === "message")
      .map((item) => (Array.isArray(item.content) ? item.content : []).map((part) =>
        part?.type === "output_text" && typeof part.text === "string" ? part.text
          : part?.type === "refusal" && typeof part.refusal === "string" ? part.refusal : "").join(""))
      .filter(Boolean).join("\n\n");
  }

  function createResponseAccumulator() {
    const parts = new Map();
    let text = "";
    let status = "in_progress";
    let outputTokens = null;
    let incompleteReason = "";
    let terminal = false;
    function partKey(event) {
      const output = Number.isSafeInteger(event.output_index) && event.output_index >= 0 ? event.output_index : 0;
      const content = Number.isSafeInteger(event.content_index) && event.content_index >= 0 ? event.content_index : 0;
      return `${output}:${content}`;
    }
    function updateText() {
      text = [...parts.entries()].sort(([a], [b]) => {
        const ai = a.split(":").map(Number), bi = b.split(":").map(Number);
        return ai[0] - bi[0] || ai[1] - bi[1];
      }).map(([, value]) => value).join("");
      if (text.length > MAX_RESPONSE_LENGTH) throw fail("Yanıt görüntülenemeyecek kadar büyük.", "response_too_large");
    }
    function snapshot() { return { text, status, outputTokens, incompleteReason, terminal }; }
    function accept(event) {
      if (terminal) return snapshot();
      if (event.error || ["error", "response.failed", "response.cancelled"].includes(event.type)) {
        throw apiError(event.response?.error ? { error: event.response.error } : event);
      }
      if (["response.output_text.delta", "response.refusal.delta"].includes(event.type)) {
        if (typeof event.delta !== "string") throw fail("API metin olayı geçersiz.", "invalid_event");
        const key = partKey(event);
        parts.set(key, (parts.get(key) || "") + event.delta);
        updateText();
      } else if (["response.output_text.done", "response.refusal.done"].includes(event.type)) {
        const value = event.type === "response.refusal.done" ? event.refusal : event.text;
        if (typeof value !== "string") throw fail("API metin olayı geçersiz.", "invalid_event");
        parts.set(partKey(event), value);
        updateText();
      } else if (["response.completed", "response.incomplete"].includes(event.type)) {
        const response = event.response;
        const expected = event.type === "response.completed" ? "completed" : "incomplete";
        if (!response || response.object !== "response" || response.status !== expected || !Array.isArray(response.output)) {
          throw fail("API yanıtı geçerli bir tamamlanma olayı içermiyor.", "invalid_response");
        }
        if (response.error) throw apiError(response);
        text = responseText(response);
        if (text.length > MAX_RESPONSE_LENGTH) throw fail("Yanıt görüntülenemeyecek kadar büyük.", "response_too_large");
        outputTokens = Number.isSafeInteger(response.usage?.output_tokens) && response.usage.output_tokens >= 0
          ? response.usage.output_tokens : null;
        status = expected;
        incompleteReason = typeof response.incomplete_details?.reason === "string" ? response.incomplete_details.reason : "";
        terminal = true;
      }
      return snapshot();
    }
    return { accept, snapshot, finish() {
      if (!terminal) throw fail("Yanıt tamamlanmadan bağlantı kesildi. Görünen metin kısmi olabilir.", "incomplete_stream");
      return snapshot();
    } };
  }

  async function readText(response, maximum = MAX_EVENT_LENGTH) {
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > maximum) throw fail("API yanıtı çok büyük.", "response_too_large");
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        text += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (text.length > maximum) throw fail("API yanıtı çok büyük.", "response_too_large");
        if (done) return text;
      }
    } finally {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best effort. */ }
      reader.releaseLock();
    }
  }

  async function consumeResponse(response, { onUpdate = () => {}, signal } = {}) {
    const accumulator = createResponseAccumulator();
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
      const raw = await readText(response, response.ok ? MAX_RESPONSE_LENGTH : 32_000);
      let value;
      try { value = JSON.parse(raw); }
      catch { throw response.ok ? fail("API geçerli bir JSON yanıtı döndürmedi.") : apiError(null, response.status); }
      if (!response.ok || value?.error) throw apiError(value, response.status);
      const snapshot = accumulator.accept({ type: value?.status === "incomplete" ? "response.incomplete" : "response.completed", response: value });
      onUpdate(snapshot);
      return accumulator.finish();
    }
    if (!response.ok) {
      const raw = await readText(response, 32_000);
      let value;
      try { value = JSON.parse(raw); } catch { /* Use a safe HTTP error. */ }
      throw apiError(value, response.status);
    }
    if (!response.body?.getReader) throw fail("Tarayıcı yanıt akışını okuyamıyor.");
    const reader = response.body.getReader();
    let terminal = false;
    let totalBytes = 0;
    const parser = createSseParser((event) => {
      const snapshot = accumulator.accept(event);
      terminal = snapshot.terminal;
      onUpdate(snapshot);
      return !terminal;
    });
    try {
      while (!terminal) {
        if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        const { value, done } = await reader.read();
        if (done) { parser.end(); break; }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_LENGTH) throw fail("API yanıtı çok büyük.", "response_too_large");
        parser.push(value);
      }
      return accumulator.finish();
    } finally {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Never wait on a provider after a terminal event. */ }
      reader.releaseLock();
    }
  }

  function init({ getKey = () => null, getModels = () => [], onComplete = () => {}, onAnnounce = () => {} } = {}) {
    const ids = ["form", "key", "key-note", "model", "model-note", "prompt", "limit", "send", "stop", "output", "empty", "status", "elapsed", "first-token", "tokens", "error", "copy", "clear"];
    const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(`playground-${id}`)]));
    if (ids.some((id) => !ui[id])) throw new Error("Playground markup is incomplete");
    const toggle = document.getElementById("playground-key-toggle");
    const listeners = [];
    let models = [];
    let busy = false;
    let controller;
    let timeout;
    let ticker;
    let animation;
    let started = 0;
    let elapsed = 0;
    let firstToken = null;
    let abortReason = "";
    let output = "";
    let tokens = null;
    let disposed = false;
    const now = () => performance.now();
    function listen(node, event, listener) { node.addEventListener(event, listener); listeners.push(() => node.removeEventListener(event, listener)); }
    function status(label, kind = "idle") { ui.status.textContent = label; ui.status.dataset.state = kind; }
    function renderMetrics() {
      ui.elapsed.textContent = started ? `${((busy ? now() - started : elapsed) / 1000).toFixed(1)} sn` : "—";
      ui["first-token"].textContent = firstToken === null ? "—" : `${(firstToken / 1000).toFixed(2)} sn`;
      ui.tokens.textContent = tokens === null ? "—" : new Intl.NumberFormat("tr-TR").format(tokens);
    }
    function renderOutput() {
      animation = undefined;
      ui.output.textContent = output;
      ui.empty.hidden = Boolean(output);
      ui.output.hidden = !output;
      ui.copy.disabled = !output;
      renderMetrics();
    }
    function scheduleOutput() { if (animation === undefined) animation = requestAnimationFrame(renderOutput); }
    function setBusy(value) {
      busy = value;
      ui.send.disabled = value || !models.length;
      ui.stop.disabled = !value;
      ui.stop.hidden = !value;
      for (const name of ["key", "model", "prompt", "limit", "clear"]) ui[name].disabled = value;
      if (toggle) toggle.disabled = value;
      ui.form.setAttribute("aria-busy", String(value));
    }
    function showError(message) { ui.error.textContent = safeMessage(message); ui.error.hidden = false; }
    function updateKeyNote() {
      const available = keyPattern.test(String(getKey() || ""));
      ui["key-note"].textContent = ui.key.value.trim() ? "Bu anahtar yalnızca bu sayfa açıkken bellekte tutulur."
        : available ? "Yeni oluşturduğun kişisel anahtar bu oturumda otomatik kullanılabilir."
          : "Tam anahtarın tekrar gösterilmez; kaydettiğin kişisel kly_ anahtarını gir.";
    }
    function updateModelNote() {
      const selected = models.find((model) => model.id === ui.model.value);
      const warning = selected?.availability === "balance_required";
      ui["model-note"].textContent = warning ? selected.note || "Son testte sağlayıcı bu model grubu için yetersiz bakiye bildirdi."
        : "Gönderdiğin her test, hesabının kullanım kotasından düşer.";
      ui["model-note"].classList.toggle("warning", Boolean(warning));
    }
    function setModels(offered = getModels()) {
      const selected = ui.model.value;
      const seen = new Set();
      models = (Array.isArray(offered) ? offered : []).filter((model) => MODEL_IDS.includes(model?.id)
        && !seen.has(model.id) && seen.add(model.id)).map((model) => ({ id: model.id,
        availability: model.availability === "balance_required" ? "balance_required" : "configured",
        note: typeof model.note === "string" ? model.note.slice(0, 300) : "" }));
      ui.model.replaceChildren();
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = MODEL_NAMES[model.id] + (model.availability === "balance_required" ? " · Bakiye gerekli" : "");
        ui.model.append(option);
      }
      if (models.some((model) => model.id === selected)) ui.model.value = selected;
      ui.send.disabled = busy || !models.length;
      ui.model.disabled = busy || !models.length;
      updateKeyNote();
      updateModelNote();
    }
    function clearKey() {
      if (controller && busy) { abortReason = "user"; controller.abort(); }
      ui.key.value = "";
      ui.key.type = "password";
      if (toggle) { toggle.setAttribute("aria-pressed", "false"); toggle.setAttribute("aria-label", "Anahtarı göster"); }
      updateKeyNote();
    }
    async function run(event) {
      event.preventDefault();
      if (busy || disposed) return;
      ui.error.hidden = true;
      ui.error.textContent = "";
      const key = ui.key.value.trim() || String(getKey() || "");
      let payload;
      try {
        payload = validateInput({ key, model: ui.model.value, prompt: ui.prompt.value, maxOutputTokens: Number(ui.limit.value) }, models.map((model) => model.id));
      } catch (error) { showError(error.message); status("Bilgilerini kontrol et", "error"); return; }
      controller = new AbortController();
      abortReason = "";
      output = "";
      tokens = null;
      firstToken = null;
      elapsed = 0;
      started = now();
      ui.empty.textContent = "Model yanıtı bekleniyor…";
      setBusy(true);
      status("Bağlanıyor…", "loading");
      renderOutput();
      ticker = setInterval(renderMetrics, 250);
      timeout = setTimeout(() => { abortReason = "timeout"; controller.abort(); }, TIMEOUT_MS);
      let outcome = "error";
      try {
        const response = await fetch("/api/v1/responses", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(payload), signal: controller.signal });
        const result = await consumeResponse(response, { signal: controller.signal, onUpdate(snapshot) {
          if (snapshot.text && firstToken === null) firstToken = now() - started;
          output = snapshot.text;
          tokens = snapshot.outputTokens;
          if (output && !snapshot.terminal) status("Yanıt geliyor…", "streaming");
          scheduleOutput();
        } });
        outcome = result.status;
        if (result.status === "incomplete") {
          status("Kısmi yanıt", "warning");
          showError(result.incompleteReason === "max_output_tokens"
            ? "Çıktı sınırına ulaşıldı. Daha kısa bir yanıt isteyebilir veya çıktı sınırını artırabilirsin."
            : "Sağlayıcı yanıtı eksik tamamladı. Görünen metin kısmi olabilir.");
        } else status("Tamamlandı", "complete");
        if (!output) ui.empty.textContent = "Sağlayıcı görünür bir metin döndürmedi.";
      } catch (error) {
        if (controller.signal.aborted) {
          outcome = abortReason === "timeout" ? "timeout" : "cancelled";
          status(abortReason === "timeout" ? "Zaman aşımı" : "Durduruldu", "warning");
          if (abortReason === "timeout") showError("120 saniye içinde tamamlanamadı. Görünen metin kısmi olabilir; daha kısa bir istemle yeniden deneyebilirsin.");
        } else {
          status("İstek tamamlanamadı", "error");
          showError(error.code ? error.message : "API bağlantısı kesildi veya kurulamadı. Görünen metin kısmi olabilir.");
        }
      } finally {
        clearTimeout(timeout);
        clearInterval(ticker);
        if (animation !== undefined) { cancelAnimationFrame(animation); animation = undefined; }
        elapsed = now() - started;
        setBusy(false);
        if (!output) ui.empty.textContent = outcome === "completed" ? "Sağlayıcı görünür bir metin döndürmedi."
          : outcome === "incomplete" ? "Görünür metin oluşmadan yanıt sınırına ulaşıldı."
            : outcome === "cancelled" ? "Test durduruldu."
              : outcome === "timeout" ? "Test zaman aşımına uğradı." : "Yanıt alınamadı. Hata ayrıntısını kontrol et.";
        renderOutput();
        try { onComplete({ status: outcome, model: payload.model }); } catch { /* A dashboard refresh must not change the test result. */ }
      }
    }
    listen(ui.form, "submit", run);
    listen(ui.stop, "click", () => { if (busy) { abortReason = "user"; controller.abort(); } });
    listen(ui.key, "input", updateKeyNote);
    listen(ui.model, "change", updateModelNote);
    if (toggle) listen(toggle, "click", () => {
      const visible = ui.key.type === "password";
      ui.key.type = visible ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(visible));
      toggle.setAttribute("aria-label", visible ? "Anahtarı gizle" : "Anahtarı göster");
    });
    listen(ui.copy, "click", async () => {
      if (!output) return;
      try { await navigator.clipboard.writeText(output); onAnnounce("Yanıt kopyalandı"); }
      catch { onAnnounce("Kopyalanamadı. Yanıt metnini elle seçebilirsin."); }
    });
    listen(ui.clear, "click", () => {
      if (busy) return;
      output = ""; tokens = null; firstToken = null; started = 0; elapsed = 0;
      ui.error.hidden = true;
      ui.empty.textContent = "Yanıt burada görünecek.";
      status("Hazır", "idle");
      renderOutput();
    });
    listen(window, "pagehide", clearKey);
    ui.prompt.maxLength = 8000;
    ui.limit.min = "64";
    ui.limit.max = "4096";
    ui.limit.step = "1";
    if (!ui.limit.value) ui.limit.value = "512";
    setModels();
    setBusy(false);
    status("Hazır", "idle");
    renderOutput();
    return Object.freeze({ setModels, clearKey, dispose() {
      if (disposed) return;
      disposed = true;
      clearKey();
      clearTimeout(timeout);
      clearInterval(ticker);
      if (animation !== undefined) cancelAnimationFrame(animation);
      for (const remove of listeners) remove();
    } });
  }

  return Object.freeze({ init, validateInput, createSseParser, createResponseAccumulator, consumeResponse, safeMessage, MODEL_IDS });
});

(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const state = { key: null, secret: null, revealed: false, busy: false, daily: 50, minute: 5, model: "gpt-6.1-sol", loaded: false };
  let toastTimeout;

  const formattedNumber = (number) => new Intl.NumberFormat("tr-TR").format(number);
  const safeNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  const dateLabel = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(date);
  };

  function announce(message, success = false) {
    const box = byId("message-box");
    box.textContent = message;
    box.classList.toggle("success", success);
    box.setAttribute("role", success ? "status" : "alert");
    box.hidden = false;
  }

  function clearMessage() {
    byId("message-box").hidden = true;
    byId("message-box").textContent = "";
  }

  function toast(message) {
    clearTimeout(toastTimeout);
    const box = byId("toast");
    box.querySelector("span").textContent = message;
    box.hidden = false;
    toastTimeout = setTimeout(() => { box.hidden = true; }, 2500);
  }

  function setBusy(value) {
    state.busy = value;
    for (const id of ["create-key", "rotate-key", "revoke-key"]) byId(id).disabled = value || !state.loaded;
    byId("retry-keys").disabled = value;
    byId("key-active").setAttribute("aria-busy", String(value));
  }

  function updateExample() {
    const key = state.secret && state.revealed ? state.secret : "YOUR_KEY";
    byId("code-example").textContent = exampleFor(key);
  }

  function exampleFor(key) {
    return [
      "curl https://klyapi.vercel.app/api/v1/responses \\",
      `  -H "Authorization: Bearer ${key}" \\`,
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      `    "model": "${state.model}",`,
      '    "input": "Merhaba!",',
      '    "max_output_tokens": 256',
      "  }'",
    ].join("\n");
  }

  function renderSecret() {
    const keyValue = byId("key-value");
    keyValue.textContent = state.secret && state.revealed ? state.secret : `${state.key?.prefix || "kly_"}••••••••••••••••••••••••••••`;
    keyValue.classList.toggle("revealed", Boolean(state.secret && state.revealed));
    byId("reveal-key").hidden = !state.secret;
    byId("copy-key").hidden = !state.secret;
    byId("reveal-key").setAttribute("aria-pressed", String(state.revealed));
    byId("reveal-key").setAttribute("aria-label", state.revealed ? "Anahtarı gizle" : "Anahtarı göster");
    byId("reveal-key").title = state.revealed ? "Anahtarı gizle" : "Anahtarı göster";
    byId("key-help").classList.toggle("new-key", Boolean(state.secret));
    byId("key-help").querySelector("span").textContent = state.secret
      ? "Anahtarını şimdi kopyalayıp kaydet. Sayfadan ayrılınca tamamı tekrar gösterilmez."
      : "Anahtarın tamamı tekrar gösterilemez. Kaybettiysen yeni bir anahtar oluşturabilirsin.";
    updateExample();
  }

  function renderService(service) {
    const available = service?.generation_available === true;
    byId("service-notice").classList.toggle("available", available);
    byId("service-title").textContent = available ? "Model erişimi açık" : "Üretim erişimi bekleniyor";
    byId("service-message").textContent = service?.message || "Model erişimi kontrol ediliyor.";
    byId("service-tag").textContent = available ? "Kullanılabilir" : "Sağlayıcı kısıtlaması";
  }

  function render(data) {
    state.key = data.key || null;
    state.daily = safeNumber(data.key?.daily_limit ?? data.limits?.daily_requests, 50);
    state.minute = safeNumber(data.limits?.requests_per_minute, 5);
    state.model = typeof data.service?.model === "string" ? data.service.model : "gpt-6.1-sol";
    state.loaded = true;
    const usage = state.key ? safeNumber(state.key.used_today, 0) : 0;
    const remaining = state.key ? safeNumber(state.key.remaining_today, Math.max(0, state.daily - usage)) : state.daily;

    byId("daily-limit").textContent = formattedNumber(state.daily);
    byId("empty-daily-limit").textContent = formattedNumber(state.daily);
    byId("minute-limit").textContent = formattedNumber(state.minute);
    byId("usage-count").textContent = formattedNumber(usage);
    byId("model-name").textContent = state.model;
    byId("model-id").value = state.model;
    byId("remaining-label").textContent = `${formattedNumber(remaining)} istek kaldı · Her gün yenilenir`;
    byId("usage-fill").style.width = `${state.daily ? Math.min(100, (usage / state.daily) * 100) : 0}%`;
    byId("usage-progress").setAttribute("aria-valuemax", String(state.daily));
    byId("usage-progress").setAttribute("aria-valuenow", String(usage));
    byId("key-loading").hidden = true;
    byId("key-error").hidden = true;
    byId("key-empty").hidden = Boolean(state.key);
    byId("key-active").hidden = !state.key;
    byId("key-badge").textContent = state.key ? "1 aktif anahtar" : "Henüz anahtar yok";
    byId("key-badge").classList.toggle("active", Boolean(state.key));

    if (state.key) {
      const created = dateLabel(state.key.created_at);
      byId("key-created").textContent = created ? `${created} tarihinde oluşturuldu` : "Kişisel erişim anahtarı";
      const expires = dateLabel(state.key.expires_at);
      byId("key-expiry").textContent = expires ? `Geçerlilik: ${expires}` : "30 gün geçerli";
      renderSecret();
    } else {
      state.secret = null;
      state.revealed = false;
      updateExample();
    }

    renderService(data.service);
    setBusy(state.busy);
  }

  async function request(method) {
    const response = await fetch("/api/keys", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    if (response.status === 204) return null;
    let body;
    try { body = await response.json(); } catch { throw new Error("Sunucudan geçerli bir yanıt alınamadı. Biraz sonra yeniden dene."); }
    if (!response.ok) {
      const detail = typeof body.error === "string" ? body.error : body.error?.message;
      const retryAfter = Number(response.headers.get("Retry-After"));
      const suffix = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? ` ${retryAfter} saniye sonra yeniden deneyebilirsin.` : "";
      throw Object.assign(new Error((detail || "İşlem tamamlanamadı. Biraz sonra yeniden dene.") + suffix), {
        status: response.status,
        code: typeof body.error === "object" ? body.error?.code : undefined,
      });
    }
    return body;
  }

  async function refresh() {
    const wasBusy = state.busy;
    setBusy(true);
    clearMessage();
    try {
      const data = await request("GET");
      render(data);
    } catch (error) {
      state.loaded = false;
      const storageUnavailable = error.status === 503 && error.code === "storage_unavailable";
      byId("key-loading").hidden = true;
      byId("key-empty").hidden = true;
      byId("key-active").hidden = true;
      byId("key-error").hidden = false;
      byId("key-badge").textContent = storageUnavailable ? "Servis hazırlanıyor" : "Bağlantı kurulamadı";
      byId("key-badge").classList.remove("active");
      byId("key-error-title").textContent = storageUnavailable ? "Anahtar servisi henüz hazır değil" : "Anahtar bilgileri alınamadı";
      byId("key-error-description").textContent = storageUnavailable
        ? "Anahtar oluşturma şu anda kullanılamıyor. Biraz sonra yeniden deneyebilirsin."
        : "Bağlantını kontrol edip yeniden deneyebilirsin.";
      byId("remaining-label").textContent = "Kullanım bilgisi şu anda alınamıyor";
    } finally {
      setBusy(wasBusy);
    }
  }

  async function createKey() {
    if (state.busy || !state.loaded) return;
    clearMessage();
    setBusy(true);
    try {
      const data = await request("POST");
      state.secret = data.api_key || null;
      state.revealed = false;
      render(data);
      announce("Anahtarın oluşturuldu. Tam anahtarını aşağıdaki kopyalama düğmesiyle kaydet.", true);
    } catch (error) {
      announce(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(rotate = false) {
    if (state.busy || !state.key) return;
    const prompt = rotate
      ? "Mevcut anahtar iptal edilip yenisi oluşturulacak. Eski anahtarı kullanan uygulamaları yeni anahtarla güncellemen gerekecek. Devam edilsin mi?"
      : "Bu API anahtarı iptal edilecek ve onu kullanan uygulamalar erişimini kaybedecek. Devam edilsin mi?";
    if (!window.confirm(prompt)) return;
    clearMessage();
    setBusy(true);
    try {
      await request("DELETE");
      state.key = null;
      state.secret = null;
      state.revealed = false;
      if (rotate) {
        const data = await request("POST");
        state.secret = data.api_key || null;
        render(data);
        announce("Yeni anahtarın oluşturuldu. Uygulamalarındaki eski anahtarı yenisiyle değiştir.", true);
      } else {
        render(await request("GET"));
        announce("Anahtarın iptal edildi.", true);
      }
    } catch (error) {
      await refresh();
      announce(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, successMessage) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast(successMessage);
    } catch {
      announce("Otomatik kopyalama kullanılamadı. Anahtarı veya alanı gösterip elle seçerek kopyalayabilirsin.");
    }
  }

  byId("create-key").addEventListener("click", createKey);
  byId("retry-keys").addEventListener("click", refresh);
  byId("rotate-key").addEventListener("click", () => revokeKey(true));
  byId("revoke-key").addEventListener("click", () => revokeKey(false));
  byId("reveal-key").addEventListener("click", () => { state.revealed = !state.revealed; renderSecret(); });
  byId("copy-key").addEventListener("click", () => { if (state.secret) copy(state.secret, "API anahtarın kopyalandı"); });
  byId("copy-example").addEventListener("click", () => copy(exampleFor(state.secret || "YOUR_KEY"), "İstek örneği kopyalandı"));
  document.querySelectorAll("[data-copy-target]").forEach((button) => button.addEventListener("click", () => copy(byId(button.dataset.copyTarget).value, "Kopyalandı")));
  window.addEventListener("pagehide", () => {
    state.secret = null;
    state.revealed = false;
    if (state.key) renderSecret();
    else updateExample();
  });
  setBusy(false);
  fetch("/api", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
    .then((service) => { if (service) renderService(service); }).catch(() => {});
  refresh();
})();

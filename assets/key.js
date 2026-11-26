(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const state = { user: null, users: [], key: null, keys: [], keyEditId: null, secret: null, revealed: false, busy: false, daily: null, minute: null, model: "gpt-6.1-sol", exampleLanguage: "curl", loaded: false, userMode: "create", view: "overview", usersLoadedAt: 0, lastRefreshAt: 0, lastRefreshAttempt: 0, stale: false, clockOffset: 0, resets: {}, remaining: {}, usageStatus: "unavailable" };
  let toastTimeout;
  let refreshPromise;
  let usersPromise;
  let refreshTimer;
  let countdownTimer;
  let commandIndex = 0;
  let playground;
  let activity;
  let playgroundPromise;
  let suspended = false;
  let lifecycleRevision = 0;
  let identityRevision = 0;
  let authenticationPromise;
  let authenticationRevision = 0;
  let usersRequestRevision = 0;
  const requestControllers = new Set();
  const AUTO_REFRESH_MS = 60000;
  const USER_CACHE_MS = 30000;
  const MODEL_NAMES = Object.freeze({ "gpt-6.1-sol": "GPT 6.1 Sol", "gpt-6-astra": "GPT 6 Astra" });
  let modelCatalogSignature = "";
  let modelCatalog = [];

  const numberFormatter = new Intl.NumberFormat("tr-TR");
  const dateFormatter = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  const formattedNumber = (number) => numberFormatter.format(number);
  const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const countLabel = (value) => value === null ? "—" : formattedNumber(value);
  const timestamp = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z") ? parsed : NaN;
  };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function usageCounts(value, suffix = "") {
    if (!record(value)) return null;
    const input = tokenCount(value[`input_tokens${suffix}`]);
    const output = tokenCount(value[`output_tokens${suffix}`]);
    const total = tokenCount(value[`total_tokens${suffix}`]);
    return input !== null && output !== null && total !== null && Number.isSafeInteger(input + output)
      && total === input + output ? { input, output, total } : null;
  }
  function accountingRecord(value) {
    if (!record(value) || value.source !== "provider_usage" || !["complete", "partial"].includes(value.status)
      || value.quota_scope !== "application_daily" || value.provider_balance !== null
      || value.provider_balance_status !== "not_exposed" || value.reserved_kind !== "admission_estimate"
      || tokenCount(value.unknown_requests_today) === null || typeof value.legacy_usage_unknown !== "boolean"
      || (value.status === "complete" && (value.unknown_requests_today > 0 || value.legacy_usage_unknown))) return null;
    if (value.last_settlement !== null) {
      const receipt = value.last_settlement;
      if (!record(receipt) || !usageCounts(receipt) || !Number.isFinite(timestamp(receipt.recorded_at))
        || !(receipt.response_id === null || typeof receipt.response_id === "string")
        || !(receipt.model === null || typeof receipt.model === "string")) return null;
    }
    return value;
  }
  const dateLabel = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return dateFormatter.format(date);
  };

  function clearSensitiveKey() {
    state.secret = null;
    state.revealed = false;
    renderSecret();
    playground?.clearKey?.();
  }

  function synchronizeUser(user) {
    if (!user || typeof user.username !== "string") return;
    const changed = state.user && (state.user.username.toLowerCase() !== user.username.toLowerCase()
      || state.user.role !== user.role);
    if (changed) {
      identityRevision++;
      clearSensitiveKey();
      activity?.clear();
      state.keys = [];
      state.key = null;
      byId("project-key-list").replaceChildren();
      state.users = [];
      state.usersLoadedAt = 0;
      byId("user-list").replaceChildren();
      byId("users-count").textContent = "—";
      byId("user-match-count").textContent = "";
      for (const id of ["user-dialog", "password-dialog", "command-dialog", "project-keys-dialog"]) {
        if (byId(id).open) byId(id).close();
      }
    }
    state.user = user;
    for (const id of ["sidebar-user", "account-name"]) byId(id).textContent = user.username;
    for (const id of ["sidebar-avatar", "account-avatar"]) byId(id).textContent = user.username.slice(0, 1).toUpperCase();
    byId("sidebar-role").textContent = user.role === "admin" ? "Yönetici" : "Kullanıcı";
    byId("nav-users").hidden = user.role !== "admin";
    if (state.view === "users" && user.role !== "admin") selectView("overview", { historyMode: "replace", focus: false });
  }

  function announce(message, success = false) {
    const box = byId("message-box");
    box.textContent = message;
    box.classList.toggle("success", success);
    box.setAttribute("role", success ? "status" : "alert");
    box.hidden = false;
    if (state.view !== "overview") toast(message);
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
    for (const id of ["access-manage-keys", "manage-project-keys", "next-manage-keys", "save-project-key", "project-key-select"]) byId(id).disabled = value || !state.loaded;
    byId("project-key-list").querySelectorAll("button").forEach(button => { button.disabled = value || button.dataset.current === "true"; });
  }

  function updateExample() {
    const key = state.secret && state.revealed ? state.secret : "YOUR_KEY";
    byId("code-example").textContent = exampleFor(key);
    if (byId("overview-code")) byId("overview-code").textContent = exampleFor(key, state.exampleLanguage);
    const language = { curl: ["cURL", "quickstart.sh"], javascript: ["JavaScript", "quickstart.mjs"], python: ["Python", "quickstart.py"] }[state.exampleLanguage];
    if (byId("example-language-tag")) byId("example-language-tag").textContent = language[0];
    const file = byId("example-file");
    if (file) {
      const icon = file.querySelector("svg");
      file.replaceChildren(...(icon ? [icon] : []), document.createTextNode(language[1]));
    }
    document.querySelectorAll("[data-example-language]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.exampleLanguage === state.exampleLanguage)));
    if (byId("codex-config")) byId("codex-config").textContent = window.KlyCodexConfig.buildConfig(
      state.secret && state.revealed ? state.secret : undefined, state.model);
  }

  function exampleFor(key, language = "curl") {
    if (language === "javascript") return [
      'const response = await fetch("https://klyapi.vercel.app/api/v1/responses", {',
      '  method: "POST",',
      '  headers: {',
      `    Authorization: "Bearer ${key}",`,
      '    "Content-Type": "application/json",',
      '  },',
      '  body: JSON.stringify({',
      `    model: "${state.model}",`,
      '    input: "Merhaba!",',
      '    max_output_tokens: 256,',
      '  }),',
      '});',
      'if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);',
      'console.log(await response.json());',
    ].join("\n");
    if (language === "python") return [
      'import json',
      'import urllib.request',
      '',
      'payload = {',
      `    "model": "${state.model}",`,
      '    "input": "Merhaba!",',
      '    "max_output_tokens": 256,',
      '}',
      'request = urllib.request.Request(',
      '    "https://klyapi.vercel.app/api/v1/responses",',
      '    data=json.dumps(payload).encode("utf-8"),',
      '    headers={',
      `        "Authorization": "Bearer ${key}",`,
      '        "Content-Type": "application/json",',
      '    },',
      '    method="POST",',
      ')',
      'with urllib.request.urlopen(request) as response:',
      '    print(json.dumps(json.load(response), ensure_ascii=False, indent=2))',
    ].join("\n");
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
    byId("service-title").textContent = available ? "API bağlantısı yapılandırıldı" : "Sunucu ayarı bekleniyor";
    byId("service-message").textContent = service?.message || "Model yanıtını deneme alanından kontrol edebilirsin.";
    byId("service-tag").textContent = available ? "Tanımlı" : "Bekleniyor";
  }

  function renderModels(service) {
    const offered = Array.isArray(service?.models) ? service.models : [{ id: service?.model || "gpt-6.1-sol" }];
    const ids = [...new Set(offered.map((model) => model?.id).filter((id) => Object.hasOwn(MODEL_NAMES, id)))];
    modelCatalog = ids.map((id) => {
      const item = offered.find((model) => model?.id === id);
      return { id, availability: item?.availability === "balance_required" ? "balance_required" : "configured", note: typeof item?.note === "string" ? item.note.slice(0, 300) : "" };
    });
    if (!ids.includes(state.model)) state.model = ids[0] || "gpt-6.1-sol";
    const signature = JSON.stringify(modelCatalog);
    if (modelCatalogSignature !== signature || !byId("model-catalog").dataset.loaded) {
      modelCatalogSignature = signature;
      const catalog = byId("model-catalog");
      catalog.dataset.loaded = "true";
      catalog.replaceChildren();
      byId("setup-model").replaceChildren();
      for (const id of ids) {
        const item = modelCatalog.find((model) => model.id === id);
        const needsBalance = item.availability === "balance_required";
        const option = element("option", "", `${MODEL_NAMES[id]}${needsBalance ? " · Bakiye gerekli" : ""}`);
        option.value = id;
        byId("setup-model").append(option);
        const card = element("article", "model-catalog-card panel");
        const heading = element("div", "model-catalog-heading");
        heading.append(element("span", "model-catalog-icon", "G"));
        const identity = element("div");
        identity.append(element("span", "model-status", "API kataloğu"), element("h2", "", MODEL_NAMES[id]), element("p", "", id));
        heading.append(identity, element("span", `outline-badge ${needsBalance ? "warning" : "active"}`, needsBalance ? "Bakiye gerekli" : "Sunuluyor"));
        const details = element("div", "model-catalog-meta");
        for (const [label, value] of [["API yolu", "/api/v1/responses"], ["Uyumluluk", "Responses · Chat Completions"]]) {
          const item = element("div");
          item.append(element("span", "", label), element("code", "", value));
          details.append(item);
        }
        const use = element("button", "button subtle", "Bu modelle kur");
        use.type = "button";
        use.addEventListener("click", () => { setModel(id); selectView("setup"); });
        const footer = element("div", "model-catalog-note");
        const tryModel = element("button", "button subtle", "Modeli dene");
        tryModel.type = "button";
        tryModel.addEventListener("click", () => { setModel(id); selectView("playground"); });
        footer.append(element("span", "", item.note || "Yanıt süreleri ve araç desteği sağlayıcıya bağlıdır."), use, tryModel);
        const observed = element("p", "model-observed", "Hesabındaki son kullanım kontrol ediliyor…");
        observed.dataset.model = id;
        card.append(heading, details, observed, footer);
        catalog.append(card);
      }
      if (!ids.length) catalog.append(element("p", "users-empty", "Şu anda yapılandırılmış model bulunmuyor."));
    }
    byId("setup-model").disabled = !ids.length;
    byId("setup-model").value = ids.includes(state.model) ? state.model : "";
    byId("active-model-count").textContent = `${formattedNumber(ids.length)} model sunuluyor`;
    byId("setup-selected-model").textContent = state.model;
    byId("model-id").value = state.model;
    updateModelNote();
    playground?.setModels?.(modelCatalog);
  }

  function updateModelNote() {
    const selected = modelCatalog.find((model) => model.id === state.model);
    const needsBalance = selected?.availability === "balance_required";
    byId("setup-model-note").textContent = needsBalance ? selected.note || "Bu model için sağlayıcı hesabında özel bakiye gerekiyor." : "Seçimin yapılandırma dosyasına ve istek örneklerine uygulanır.";
    byId("setup-model-note").classList.toggle("warning", needsBalance);
  }

  function renderModelHealth(health) {
    document.querySelectorAll(".model-observed").forEach(node => {
      const item = Array.isArray(health) ? health.find(item => item.model === node.dataset.model) : null;
      const time = value => new Intl.DateTimeFormat("tr-TR", {dateStyle:"short",timeStyle:"short"}).format(new Date(value));
      const lines = [];
      if (item?.last_success_at && Number.isFinite(Date.parse(item.last_success_at))) lines.push(`Hesabında son başarılı yanıt: ${time(item.last_success_at)}`);
      if (item?.last_error_at && Number.isFinite(Date.parse(item.last_error_at))) lines.push(`Son hata: ${time(item.last_error_at)}${item.last_error_code ? ` · ${item.last_error_code}` : ""}`);
      node.textContent = health === null ? "Son kullanım bilgisi alınamadı. Geçmişten yeniden deneyebilirsin." : lines.length ? lines.join(". ") : "Saklanan geçmişte bu modelle doğrulanmış bir yanıtın henüz yok.";
    });
  }

  function setModel(model) {
    if (!Object.hasOwn(MODEL_NAMES, model) || ![...byId("setup-model").options].some((option) => option.value === model)) return;
    state.model = model;
    byId("setup-model").value = model;
    byId("setup-selected-model").textContent = model;
    byId("model-id").value = model;
    updateModelNote();
    updateExample();
    playground?.setSelectedModel?.(model);
  }

  function renderUsage(usage) {
    const accounting = accountingRecord(usage?.accounting);
    const counts = accounting && usageCounts(usage, "_today");
    const reserved = tokenCount(usage?.reserved_tokens_today);
    const valid = Boolean(counts && reserved !== null && Number.isSafeInteger(counts.total + reserved));
    state.usageStatus = valid ? accounting.status : "unavailable";
    const partial = state.usageStatus === "partial";
    const lowerBound = (value) => valid ? `${partial ? "En az " : ""}${formattedNumber(value)}` : "—";
    const reportedRemaining = tokenCount(usage?.remaining_tokens_today);
    const remaining = valid && !partial && state.daily !== null && reportedRemaining !== null
      && reportedRemaining === Math.max(0, state.daily - counts.total - reserved) ? reportedRemaining : null;
    state.remaining = { day: remaining };

    byId("usage-count").textContent = lowerBound(counts?.total);
    byId("input-token-count").textContent = lowerBound(counts?.input);
    byId("output-token-count").textContent = lowerBound(counts?.output);
    byId("remaining-token-count").textContent = countLabel(remaining);
    byId("usage-source").textContent = valid ? "Bugün · sağlayıcının bildirdiği tokenlar" : "Kullanım kaynağı doğrulanamadı";
    byId("usage-status").textContent = partial ? "Kısmi kayıt · en az" : valid ? "Sağlayıcı kaydı doğrulandı" : "Kullanım doğrulanamadı";
    byId("usage-status").dataset.state = state.usageStatus;
    const coverage = [];
    if (!valid) coverage.push("Token kayıtları eksik veya geçersiz; kullanım sıfır kabul edilmedi.");
    else if (partial) {
      if (accounting.unknown_requests_today > 0) coverage.push(`${formattedNumber(accounting.unknown_requests_today)} isteğin token kullanımı doğrulanamadı.`);
      if (accounting.legacy_usage_unknown) coverage.push("Önceki isteklerin token ayrıntıları bilinmiyor.");
      coverage.push("Sayılar kaydedilen en az kullanımdır; kalan kota doğrulanamıyor.");
    } else if (remaining === null) coverage.push("Kaydedilen kullanım doğrulandı; kullanılabilir günlük kota doğrulanamadı.");
    byId("usage-coverage").textContent = coverage.join(" ");
    byId("usage-coverage").hidden = !coverage.length;
    byId("usage-history-link").hidden = !partial;
    const meter = byId("usage-progress");
    meter.hidden = !valid || partial || state.daily === null || state.daily < 1 || remaining === null;
    if (meter.hidden) meter.removeAttribute("value");
    else { meter.max = state.daily; meter.value = counts.total; }
    byId("reserved-token-note").textContent = valid && reserved > 0
      ? `${formattedNumber(reserved)} token tahmini geçici rezervasyon. Gerçek kullanım değildir; tamamlanan isteklerin sağlayıcı sayılarıyla değiştirilir.` : "";
    byId("reserved-token-note").hidden = !valid || reserved === 0;
    for (const [period, field] of [["hour", "used_this_hour"], ["day", "used_today"], ["week", "used_this_week"]]) {
      byId(`usage-requests-${period}`).textContent = countLabel(tokenCount(usage?.[field]));
    }

    const composition = byId("usage-composition");
    composition.hidden = !valid || counts.total === 0;
    const inputShare = composition.hidden ? null : counts.input / counts.total * 100;
    const outputShare = composition.hidden ? null : counts.output / counts.total * 100;
    byId("usage-input-share").style.width = inputShare === null ? "" : `${inputShare}%`;
    byId("usage-output-share").style.width = outputShare === null ? "" : `${outputShare}%`;
    const compositionLabel = composition.hidden ? "Dağılım için doğrulanmış token kaydı yok."
      : `Kaydedilen kullanım: ${formattedNumber(counts.input)} giriş + ${formattedNumber(counts.output)} çıkış = ${formattedNumber(counts.total)} token.`;
    composition.setAttribute("aria-label", compositionLabel);
    byId("usage-composition-label").textContent = compositionLabel;

    const receipt = valid ? accounting.last_settlement : null;
    byId("usage-receipt").hidden = !receipt;
    for (const id of ["receipt-time", "receipt-model", "receipt-response", "receipt-input", "receipt-output", "receipt-total"]) byId(id).textContent = "—";
    byId("receipt-time").removeAttribute("datetime");
    if (receipt) {
      byId("receipt-time").textContent = new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }).format(new Date(receipt.recorded_at)) + " UTC";
      byId("receipt-time").setAttribute("datetime", receipt.recorded_at);
      byId("receipt-model").textContent = receipt.model || "Bildirilmedi";
      byId("receipt-response").textContent = receipt.response_id || "Bildirilmedi";
      byId("receipt-input").textContent = formattedNumber(receipt.input_tokens);
      byId("receipt-output").textContent = formattedNumber(receipt.output_tokens);
      byId("receipt-total").textContent = formattedNumber(receipt.total_tokens);
    }
  }

  function render(data) {
    synchronizeUser(data.user);
    state.keys = Array.isArray(data.keys) ? data.keys : data.key ? [data.key] : [];
    const preferred = data.api_key ? data.key?.id : state.key?.id;
    const selected = state.keys.find(key => key.id === preferred) || state.keys[0] || null;
    if (data.api_key) { clearSensitiveKey(); state.key = null; state.secret = data.api_key; state.revealed = false; }
    const keyChanged = state.key && selected && ["id", "prefix", "created_at", "expires_at"]
      .some((field) => state.key[field] !== selected[field]);
    const secretMismatch = state.secret && selected && (typeof selected.prefix !== "string"
      || !state.secret.startsWith(selected.prefix));
    if (!selected || keyChanged || secretMismatch) clearSensitiveKey();
    state.key = selected;
    state.daily = tokenCount(data.limits?.daily_tokens);
    state.minute = tokenCount(data.limits?.requests_per_minute);
    renderModels(data.service);
    state.loaded = true;
    const serverTime = timestamp(data.usage?.server_time || data.server_time);
    state.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
    state.resets = { day: timestamp(data.usage?.day_resets_at) };
    state.lastRefreshAt = Date.now();
    state.lastRefreshAttempt = state.lastRefreshAt;
    state.stale = false;

    byId("daily-limit").textContent = countLabel(state.daily);
    byId("daily-token-credit").textContent = state.daily === 1000000000 ? "1 milyar" : countLabel(state.daily);
    byId("empty-daily-limit").textContent = countLabel(state.daily);
    byId("minute-limit").textContent = countLabel(state.minute);
    byId("model-id").value = state.model;
    renderUsage(data.usage);
    byId("key-loading").hidden = true;
    byId("key-error").hidden = true;
    byId("key-empty").hidden = Boolean(state.key);
    byId("key-active").hidden = !state.key;
    byId("key-badge").textContent = state.key ? `${state.keys.length} aktif anahtar` : "Henüz anahtar yok";
    byId("key-badge").classList.toggle("active", Boolean(state.key));

    if (state.key) {
      byId("selected-key-name").textContent = state.key.name || "Kişisel erişim anahtarı";
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

    renderProjectKeys();
    byId("access-key-name").textContent = state.key?.name || (state.key ? "Kişisel proje" : "İlk projenle başla");
    byId("access-key-count").textContent = state.keys.length ? `${state.keys.length} aktif anahtar · Tek hesap kotası` : "Adlandırılmış anahtarını oluştur, uygulamanı bağla";

    renderService(data.service);
    updateUsageClock();
    scheduleRefresh();
    setBusy(state.busy);
  }

  function durationLabel(milliseconds) {
    const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
    if (minutes < 60) return `${minutes} dk`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return `${hours} sa${rest ? ` ${rest} dk` : ""}`;
    return `${Math.floor(hours / 24)} gün${hours % 24 ? ` ${hours % 24} sa` : ""}`;
  }

  function updateUsageClock() {
    if (!state.loaded) return;
    const age = Date.now() - state.lastRefreshAt;
    byId("usage-updated").textContent = state.stale ? "Yenilenemedi · Son alınan veriler gösteriliyor" : age < 60000 ? "Az önce güncellendi" : `${Math.floor(age / 60000)} dk önce güncellendi`;
    byId("usage-updated").classList.toggle("stale", state.stale);
    const now = Date.now() + state.clockOffset;
    const reset = state.resets.day;
    const when = Number.isFinite(reset) ? reset <= now ? "Yenilenme zamanı geldi" : `${durationLabel(reset - now)} sonra yenilenir` : "Yenilenme zamanı bildirilmedi";
    byId("remaining-label").textContent = state.usageStatus === "partial" ? "Kayıt kısmi · Kullanılabilir günlük kota doğrulanamıyor"
      : state.remaining.day === null ? "Kullanılabilir günlük kota doğrulanamadı"
        : `${formattedNumber(state.remaining.day)} token uygulama kotası kaldı · ${when}`;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    if (suspended || document.hidden || state.view !== "overview" || !state.user || !state.loaded) return;
    countdownTimer = setInterval(updateUsageClock, 15000);
    const delay = Math.max(1000, AUTO_REFRESH_MS - (Date.now() - state.lastRefreshAttempt));
    refreshTimer = setTimeout(() => refresh({ background: true }), delay);
  }

  async function request(method, payload) {
    return api("/api/keys", method, method === "GET" ? undefined : payload || {});
  }

  async function api(url, method = "GET", payload, { responseType = "json" } = {}) {
    if (suspended) throw Object.assign(new Error("Sayfa artık etkin değil."), { code: "page_inactive" });
    const revision = lifecycleRevision;
    const identity = identityRevision;
    const controller = new AbortController();
    requestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (revision !== lifecycleRevision || identity !== identityRevision) throw Object.assign(new Error("Oturum değişti."), { code: "page_inactive" });
    if (response.status === 401 && url !== "/api/auth") {
      state.user = null;
      identityRevision++;
      clearSensitiveKey();
      activity?.clear();
      state.users = [];
      state.usersLoadedAt = 0;
      byId("user-list").replaceChildren();
      if (state.key) renderSecret();
      updateExample();
      scheduleRefresh();
      window.location.replace("/login");
      throw Object.assign(new Error("Oturumun sona erdi. Yeniden giriş yap."), { status: 401 });
    }
    if (response.status === 204) return null;
    if (response.ok && responseType === "text") return await response.text();
    let body;
    try { body = await response.json(); } catch { throw new Error("Sunucudan geçerli bir yanıt alınamadı. Biraz sonra yeniden dene."); }
    if (revision !== lifecycleRevision || identity !== identityRevision) throw Object.assign(new Error("Oturum değişti."), { code: "page_inactive" });
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
    } catch (error) {
      if (suspended || revision !== lifecycleRevision) throw Object.assign(new Error("İşlem sayfadan ayrıldığın için durduruldu."), { code: "page_inactive" });
      if (controller.signal.aborted) throw new Error("Sunucu yanıtı gecikti. Yeniden deneyebilirsin.");
      throw error;
    } finally { clearTimeout(timeout); requestControllers.delete(controller); }
  }

  async function refresh({ background = false, allowBusy = false } = {}) {
    if (suspended) return;
    if (refreshPromise) return refreshPromise;
    if (state.busy && !allowBusy) { scheduleRefresh(); return; }
    state.lastRefreshAttempt = Date.now();
    if (!background) clearMessage();
    byId("refresh-usage").disabled = true;
    byId("refresh-usage").setAttribute("aria-busy", "true");
    refreshPromise = (async () => {
    try {
      const data = await api("/api/account");
      render(data);
    } catch (error) {
      if (error.code === "page_inactive") return;
      if (state.loaded) {
        state.stale = true;
        updateUsageClock();
        if (!background) toast("Kullanım yenilenemedi. Son veriler gösteriliyor.");
        return;
      }
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
      byId("usage-updated").textContent = "Kullanım bilgisi alınamadı";
      renderUsage(undefined);
    } finally {
      byId("refresh-usage").disabled = false;
      byId("refresh-usage").setAttribute("aria-busy", "false");
      refreshPromise = null;
      setBusy(state.busy);
      scheduleRefresh();
    }
    })();
    return refreshPromise;
  }

  async function createKey(name) {
    if (refreshPromise) await refreshPromise;
    if (suspended || !state.user || state.busy || !state.loaded) return;
    clearMessage();
    setBusy(true);
    try {
      const data = await request("POST", { name });
      render(data);
      byId("project-keys-dialog").close();
      announce("Anahtarın oluşturuldu. Tam anahtarını aşağıdaki kopyalama düğmesiyle kaydet.", true);
    } catch (error) {
      if (error.code !== "page_inactive") {
        if (byId("project-keys-dialog").open) showFormMessage("project-key-message", error.message);
        else announce(error.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(target = state.key) {
    if (refreshPromise) await refreshPromise;
    if (suspended || !state.user || state.busy || !target) return;
    const prompt = `“${target.name || "Kişisel proje"}” anahtarı iptal edilecek. Bu anahtarı kullanan uygulamalar erişimini kaybeder; diğer proje anahtarları çalışmaya devam eder. Devam edilsin mi?`;
    if (!window.confirm(prompt)) return;
    clearMessage();
    setBusy(true);
    try {
      await request("DELETE", target.id ? { id: target.id } : {});
      if (target.id === state.key?.id) { state.key = null; clearSensitiveKey(); updateExample(); }
      render(await request("GET"));
      announce("Yalnızca seçtiğin proje anahtarı iptal edildi.", true);
      if (byId("project-keys-dialog").open) showFormMessage("project-key-message", "Seçtiğin anahtar iptal edildi; diğer projelerin erişimi korunuyor.");
    } catch (error) {
      if (error.code === "page_inactive") return;
      await refresh({ allowBusy: true });
      announce(error.message);
      if (byId("project-keys-dialog").open) showFormMessage("project-key-message", error.message);
    } finally {
      setBusy(false);
    }
  }

  function resetKeyEditor() {
    state.keyEditId = null;
    byId("project-key-name").value = "";
    byId("project-key-name-label").textContent = "Yeni projenin adı";
    byId("save-project-key").textContent = "Anahtar oluştur";
    byId("cancel-key-rename").hidden = true;
    byId("project-key-form-note").textContent = "Tam anahtar yalnızca oluşturulduğunda gösterilir; güvenli bir yerde sakla.";
  }

  function openProjectKeys({ replacement = false } = {}) {
    if (!state.loaded || !state.user) return;
    resetKeyEditor();
    byId("project-key-message").hidden = true;
    if (replacement && state.key) {
      byId("project-key-name").value = `${(state.key.name || "Kişisel proje").slice(0,41).trimEnd()} - yeni`;
      byId("project-key-form-note").textContent = "Yeni anahtar önce oluşturulur. Uygulamanı taşıdıktan sonra eski anahtarı ayrıca iptal edebilirsin; şimdi iptal edilmeyecek.";
    }
    renderProjectKeys();
    if (!byId("project-keys-dialog").open) byId("project-keys-dialog").showModal();
    byId("project-key-name").focus();
  }

  function selectProjectKey(key) {
    if (state.key?.id !== key.id) clearSensitiveKey();
    state.key = key;
    byId("selected-key-name").textContent = key.name || "Kişisel erişim anahtarı";
    byId("key-created").textContent = `${dateLabel(key.created_at)} tarihinde oluşturuldu`;
    byId("key-expiry").textContent = `Geçerlilik: ${dateLabel(key.expires_at)}`;
    byId("access-key-name").textContent = key.name || "Kişisel proje";
    renderSecret();
    renderProjectKeys();
    if (byId("project-keys-dialog").open) byId("project-keys-dialog").close();
  }

  function renderProjectKeys() {
    const select = byId("project-key-select");
    select.replaceChildren();
    for (const key of state.keys) {
      const option = element("option", "", key.name || "Kişisel proje");
      option.value = key.id || "legacy";
      select.append(option);
    }
    select.value = state.key?.id || "legacy";
    select.hidden = state.keys.length < 2;
    const list = byId("project-key-list");
    list.replaceChildren();
    if (!state.keys.length) list.append(element("p", "users-empty", "Henüz bir proje anahtarın yok. İlk projenin adını yazıp oluşturabilirsin."));
    for (const key of state.keys) {
      const row = element("article", "project-key-row");
      const identity = element("div", "project-key-identity");
      identity.append(element("strong", "", key.name || "Kişisel proje"), element("code", "", `${key.prefix}••••••••`), element("small", "", `Geçerlilik: ${dateLabel(key.expires_at) || "—"}`));
      const usage = element("div", "project-key-usage");
      const known = usageCounts(key, "_today");
      const partial = key.accounting?.status === "partial";
      usage.append(element("span", "", "Bugün kaydedilen"), element("strong", "", known ? `${partial ? "En az " : ""}${formattedNumber(known.total)} token` : "Doğrulanmış kayıt yok"));
      if (known) usage.append(element("small", "", `${formattedNumber(known.input)} giriş · ${formattedNumber(known.output)} çıkış`));
      if (key.accounting?.legacy_usage_unknown || key.accounting?.historical_usage_unknown) usage.append(element("small", "project-key-warning", "İzleme öncesindeki kullanım bu anahtara atanamaz."));
      const actions = element("div", "project-key-actions");
      const selected = actionButton(state.key?.id === key.id ? "Seçili" : "Seç", () => selectProjectKey(key), state.key?.id === key.id);
      selected.dataset.current = String(state.key?.id === key.id);
      actions.append(selected);
      const rename = actionButton("Adını düzenle", () => {
        state.keyEditId = key.id;
        byId("project-key-name").value = key.name || "Kişisel proje";
        byId("project-key-name-label").textContent = "Projenin yeni adı";
        byId("save-project-key").textContent = "Adı kaydet";
        byId("cancel-key-rename").hidden = false;
        byId("project-key-form-note").textContent = "Yalnızca adı değişir; API anahtarı ve bağlı uygulamalar etkilenmez.";
        byId("project-key-name").focus();
      });
      actions.append(rename, actionButton("İptal et", () => revokeKey(key)));
      row.append(identity, usage, actions);
      list.append(row);
    }
    byId("project-keys-title").textContent = `Proje anahtarların (${state.keys.length}/10)`;
  }

  async function saveProjectKey(event) {
    event.preventDefault();
    if (state.busy || !byId("project-key-form").reportValidity()) return;
    const name = byId("project-key-name").value.normalize("NFC").trim().replace(/ {2,}/g, " ");
    if (!/^[\p{L}\p{M}\p{N} _().-]{1,48}$/u.test(name) || /(?:kly_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,})/.test(name)) { showFormMessage("project-key-message", "Proje adı 1–48 harf, rakam, boşluk veya . _ ( ) - içermeli; anahtarın kendisini yazma."); return; }
    byId("project-key-message").hidden = true;
    if (!state.keyEditId) { await createKey(name); return; }
    setBusy(true);
    try {
      const data = await request("PATCH", { id: state.keyEditId, name });
      render(data);
      resetKeyEditor();
      toast("Projenin adı güncellendi");
    } catch (error) { if (error.code !== "page_inactive") showFormMessage("project-key-message", error.message); }
    finally { setBusy(false); }
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

  function codexConfig() {
    return window.KlyCodexConfig.buildConfig(state.secret || undefined, state.model);
  }

  function configNotice(action) {
    return state.secret ? `Codex ayarları ${action}` : `Örnek ayarlar ${action}. KLYAPI_API_ANAHTARIN yerine kendi anahtarını ekle.`;
  }

  const downloadUrls = new Set();
  function downloadCodexConfig() {
    let url;
    let link;
    try {
      url = URL.createObjectURL(new Blob([codexConfig()], { type: "application/toml;charset=utf-8" }));
      downloadUrls.add(url);
      link = document.createElement("a");
      link.href = url;
      link.download = "config.toml";
      link.hidden = true;
      document.body.append(link);
      link.click();
      toast(configNotice("indirildi"));
    } catch {
      announce("Ayar dosyası indirilemedi. Kopyala düğmesini kullanıp config.toml dosyana ekleyebilirsin.");
    } finally {
      link?.remove();
      if (url) setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    }
  }

  function showFormMessage(id, message) {
    byId(id).textContent = message;
    byId(id).hidden = false;
  }

  function viewFromHash() {
    const hash = window.location.hash.toLowerCase();
    if (hash === "#models") return "models";
    if (hash === "#playground") return "playground";
    if (hash === "#users") return "users";
    if (hash === "#activity") return "activity";
    if (["#setup", "#codex-setup", "#baslarken"].includes(hash)) return "setup";
    return "overview";
  }

  function selectView(view, { historyMode = "push", focus = true } = {}) {
    if (!["overview", "models", "setup", "users", "playground", "activity"].includes(view)) view = "overview";
    if (view === "users" && state.user?.role !== "admin") view = "overview";
    const changed = state.view !== view;
    state.view = view;
    const users = view === "users";
    const models = view === "models";
    const setup = view === "setup";
    const testing = view === "playground";
    const history = view === "activity";
    byId("overview-view").hidden = users || models || setup || testing || history;
    byId("activity-view").hidden = !history;
    byId("models-view").hidden = !models;
    byId("users-view").hidden = !users;
    byId("setup-view").hidden = !setup;
    if (byId("playground-view")) byId("playground-view").hidden = !testing;
    byId("nav-overview").classList.toggle("current", view === "overview");
    byId("nav-activity").classList.toggle("current", history);
    byId("nav-models").classList.toggle("current", models);
    byId("nav-start").classList.toggle("current", setup);
    byId("nav-users").classList.toggle("current", users);
    byId("nav-playground")?.classList.toggle("current", testing);
    for (const [id, active] of [["nav-overview", view === "overview"], ["nav-models", models], ["nav-start", setup], ["nav-users", users], ["nav-playground", testing], ["nav-activity", history]]) {
      if (!byId(id)) continue;
      if (active) byId(id).setAttribute("aria-current", "page");
      else byId(id).removeAttribute("aria-current");
    }
    byId("breadcrumb-page").textContent = users ? "Kullanıcılar" : models ? "Modeller" : setup ? "Kurulum" : testing ? "Deneme alanı" : history ? "İstek geçmişi" : "Genel bakış";
    document.title = `${byId("breadcrumb-page").textContent} · KlyAPI`;
    const hash = `#${view}`;
    if (historyMode !== "none" && window.location.hash !== hash) window.history[historyMode === "replace" ? "replaceState" : "pushState"](null, "", hash);
    if (changed && focus) {
      const heading = byId(users ? "users-title" : models ? "models-title" : setup ? "start-heading" : testing ? "playground-title" : history ? "activity-title" : "page-title");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    if (users) loadUsers();
    if (testing) ensurePlayground();
    if (history) activity?.load();
    if (models) activity?.loadHealth();
    scheduleRefresh();
  }

  function ensurePlayground() {
    if (playground || playgroundPromise || suspended) return;
    const initialize = () => {
      if (suspended || playground) return;
      playground = window.KlyPlayground?.init?.({ getKey: () => state.secret, getModels: () => modelCatalog,
        onComplete: () => { activity?.invalidate(); if (!suspended && state.user) refresh({ background: true }); }, onAnnounce: toast });
      playground?.setModels?.(modelCatalog);
      playground?.setSelectedModel?.(state.model);
    };
    if (window.KlyPlayground?.init) { initialize(); return; }
    const moduleSource = byId("playground-view")?.dataset.module;
    if (!moduleSource) return;
    byId("playground-send").disabled = true;
    byId("playground-status").textContent = "Deneme alanı yükleniyor…";
    playgroundPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = moduleSource;
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error("Deneme alanı yüklenemedi. Sekmeyi yeniden açarak deneyebilirsin.")); };
      document.head.append(script);
    }).then(initialize).catch((error) => {
      if (suspended) return;
      byId("playground-status").textContent = "Yüklenemedi";
      byId("playground-error").textContent = error.message;
      byId("playground-error").hidden = false;
    }).finally(() => { playgroundPromise = null; });
  }

  async function authenticate() {
    if (authenticationPromise && authenticationRevision === lifecycleRevision) return authenticationPromise;
    byId("retry-auth").hidden = true;
    authenticationRevision = lifecycleRevision;
    const pending = (async () => {
    try {
      const data = await api("/api/account");
      if (!data.user) { window.location.replace("/login"); return; }
      byId("auth-cover").hidden = true;
      document.body.classList.remove("auth-pending");
      render(data);
      selectView(viewFromHash(), { historyMode: "replace", focus: false });
    } catch (error) {
      if (error.code === "page_inactive") return;
      if (error.status === 401) { window.location.replace("/login"); return; }
      byId("auth-status").textContent = "Oturum bilgisi alınamadı. Yeniden deneyebilirsin.";
      byId("retry-auth").hidden = false;
    } finally { if (authenticationPromise === pending) authenticationPromise = null; }
    })();
    authenticationPromise = pending;
    return pending;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, action, disabled = false, username) {
    const button = element("button", "button subtle", label);
    button.type = "button";
    button.disabled = disabled;
    if (username) button.setAttribute("aria-label", `${username}: ${label}`);
    button.addEventListener("click", action);
    return button;
  }

  function renderUsers() {
    byId("users-count").textContent = formattedNumber(state.users.length);
    const list = byId("user-list");
    list.replaceChildren();
    const query = byId("user-search").value.trim().toLocaleLowerCase("tr-TR");
    const filter = byId("user-filter").value;
    const matches = state.users.filter((user) => user.username.toLocaleLowerCase("tr-TR").includes(query)
      && (filter === "all" || (filter === "active" ? user.enabled : !user.enabled)));
    byId("user-match-count").textContent = `${formattedNumber(matches.length)} / ${formattedNumber(state.users.length)} kullanıcı`;
    if (!matches.length) { list.append(element("p", "users-empty", state.users.length ? "Aramana uygun kullanıcı bulunamadı." : "Henüz kullanıcı bulunmuyor.")); return; }
    const fragment = document.createDocumentFragment();
    for (const user of matches) {
      const row = element("article", "user-row");
      const identity = element("div", "user-identity");
      identity.append(element("span", "user-avatar", user.username.slice(0, 1).toUpperCase()));
      const info = element("div");
      const name = element("strong", "user-name", user.username);
      if (user.role === "admin") name.append(element("span", "user-role", "YÖNETİCİ"));
      info.append(name, element("span", "user-created", dateLabel(user.created_at) || "Hesap oluşturuldu"));
      identity.append(info);
      const limits = element("div", "user-limits");
      limits.append(element("span", "", `${countLabel(tokenCount(user.daily_tokens))} token / gün · uygulama kotası`), element("span", "", `${countLabel(tokenCount(user.requests_per_minute))} istek / dakika`));
      const status = element("span", `user-state${user.enabled ? "" : " disabled"}`);
      status.append(element("span"), document.createTextNode(user.enabled ? "Aktif" : "Kapalı"));
      const own = user.username.toLowerCase() === state.user.username.toLowerCase();
      const actions = element("div", "user-actions");
      actions.append(actionButton("Hız sınırı", () => openUserDialog("quota", user), false, user.username),
        actionButton("Şifre sıfırla", () => openUserDialog("password", user), own, user.username),
        actionButton(user.enabled ? "Erişimi kapat" : "Erişimi aç", () => toggleUser(user), user.role === "admin" || own, user.username));
      row.append(identity, limits, status, actions);
      fragment.append(row);
    }
    list.append(fragment);
  }

  async function loadUsers({ force = false } = {}) {
    if (suspended || state.user?.role !== "admin") return;
    if (usersPromise) {
      const revision = usersRequestRevision;
      await usersPromise;
      if (suspended || state.user?.role !== "admin") return;
      if (!force && revision === identityRevision) return;
    }
    if (!force && state.usersLoadedAt && Date.now() - state.usersLoadedAt < USER_CACHE_MS) { renderUsers(); return; }
    byId("users-message").hidden = true;
    byId("users-loading").hidden = Boolean(state.usersLoadedAt);
    byId("refresh-users").disabled = true;
    const revision = identityRevision;
    usersRequestRevision = revision;
    usersPromise = (async () => {
    try {
      const data = await api("/api/users");
      if (suspended || revision !== identityRevision || state.user?.role !== "admin") return;
      state.users = Array.isArray(data.users) ? data.users : [];
      state.usersLoadedAt = Date.now();
      renderUsers();
    } catch (error) { if (error.code !== "page_inactive" && revision === identityRevision) showFormMessage("users-message", error.message); }
    finally { byId("users-loading").hidden = true; byId("refresh-users").disabled = false; usersPromise = null; }
    })();
    return usersPromise;
  }

  function openUserDialog(mode, user) {
    state.userMode = mode;
    byId("user-form").reset();
    byId("user-form-message").hidden = true;
    byId("user-username").value = user?.username || "";
    byId("user-username").readOnly = mode !== "create";
    byId("user-password-group").hidden = mode === "quota";
    byId("user-password").required = mode !== "quota";
    byId("user-password").disabled = mode === "quota";
    byId("user-quota-group").hidden = mode === "password";
    byId("user-minute").disabled = mode === "password";
    byId("user-minute").value = user?.requests_per_minute ?? 5;
    byId("user-dialog-title").textContent = mode === "create" ? "Kullanıcı ekle" : mode === "quota" ? "Anlık hız sınırı" : "Şifreyi sıfırla";
    byId("user-dialog-description").textContent = mode === "create" ? "Kullanıcı adı ve şifre belirle. Her hesaba günlük 1 milyar token uygulama kotası uygulanır; bu sağlayıcı bakiyesi değildir." : mode === "quota" ? "Dakikalık istek hızını güncelle. Günlük 1 milyar token uygulama kotası tüm hesaplar için aynıdır." : "Kullanıcının eski şifresi geçersiz olacak. Yeni şifreyi güvenli bir kanaldan ilet.";
    byId("save-user").textContent = mode === "create" ? "Kullanıcı oluştur" : "Değişiklikleri kaydet";
    byId("user-dialog").showModal();
    if (mode === "password") byId("user-password").focus();
  }

  async function saveUser(event) {
    event.preventDefault();
    const form = byId("user-form");
    if (!form.reportValidity()) return;
    const mode = state.userMode;
    const payload = { username: byId("user-username").value.trim() };
    if (mode !== "quota") payload.password = byId("user-password").value;
    if (mode !== "password") {
      payload.requests_per_minute = Number(byId("user-minute").value);
    }
    byId("save-user").disabled = true;
    byId("user-form-message").hidden = true;
    form.setAttribute("aria-busy", "true");
    try {
      await api("/api/users", mode === "create" ? "POST" : "PATCH", payload);
      byId("user-dialog").close();
      byId("user-password").value = "";
      toast(mode === "create" ? "Kullanıcı oluşturuldu" : "Değişiklikler kaydedildi");
      await loadUsers({ force: true });
      if (payload.username.toLowerCase() === state.user.username.toLowerCase()) refresh();
    } catch (error) { showFormMessage("user-form-message", error.message); }
    finally { form.setAttribute("aria-busy", "false"); byId("save-user").disabled = false; }
  }

  async function toggleUser(user) {
    if (user.role === "admin" || user.username.toLowerCase() === state.user.username.toLowerCase()) return;
    if (user.enabled && !window.confirm(`${user.username} hesabının erişimi kapatılacak. Kullanıcı giriş yapamayacak ve API anahtarını kullanamayacak. Devam edilsin mi?`)) return;
    try {
      await api("/api/users", "PATCH", { username: user.username, enabled: !user.enabled });
      toast(user.enabled ? "Kullanıcı erişimi kapatıldı" : "Kullanıcı erişimi açıldı");
      await loadUsers({ force: true });
    } catch (error) { showFormMessage("users-message", error.message); }
  }

  async function changePassword(event) {
    event.preventDefault();
    const form = byId("password-form");
    if (!form.reportValidity()) return;
    byId("password-form-message").hidden = true;
    if (byId("new-password").value !== byId("confirm-password").value) {
      showFormMessage("password-form-message", "Yeni şifreler eşleşmiyor."); return;
    }
    byId("save-password").disabled = true;
    try {
      await api("/api/auth", "POST", { action: "password", current_password: byId("current-password").value, new_password: byId("new-password").value });
      byId("password-dialog").close();
      form.reset();
      toast("Şifren güncellendi");
    } catch (error) { showFormMessage("password-form-message", error.message); }
    finally { byId("save-password").disabled = false; }
  }

  async function logout() {
    byId("logout").disabled = true;
    try {
      await api("/api/auth", "POST", { action: "logout" });
      state.user = null;
      identityRevision++;
      clearSensitiveKey();
      activity?.clear();
      state.users = [];
      state.usersLoadedAt = 0;
      byId("user-list").replaceChildren();
      if (state.key) renderSecret();
      updateExample();
      scheduleRefresh();
      window.location.replace("/login");
    } catch (error) { announce(error.message); byId("logout").disabled = false; }
  }

  const commandViews = [
    { view: "overview", label: "Genel bakış", description: "API anahtarı ve kullanım", icon: "i-key" },
    { view: "models", label: "Modeller", description: "Kullanılabilir model bilgileri", icon: "i-code" },
    { view: "playground", label: "Deneme alanı", description: "API bağlantısını ve model yanıtını dene", icon: "i-bolt" },
    { view: "setup", label: "Kurulum", description: "Codex yapılandırması ve API bağlantısı", icon: "i-desktop" },
    { view: "activity", label: "İstek geçmişi", description: "Proje, model, süre, hata ve token kayıtları", icon: "i-clock" },
    { view: "users", label: "Kullanıcılar", description: "Hesap ve kota yönetimi", icon: "i-users", admin: true },
  ];

  function filteredCommands() {
    const query = byId("command-search").value.trim().toLocaleLowerCase("tr-TR");
    return commandViews.filter((item) => (!item.admin || state.user?.role === "admin")
      && `${item.label} ${item.description}`.toLocaleLowerCase("tr-TR").includes(query));
  }

  function runCommand(view) {
    byId("command-dialog").close();
    selectView(view);
  }

  function renderCommands() {
    const items = filteredCommands();
    commandIndex = Math.max(0, Math.min(commandIndex, items.length - 1));
    const list = byId("command-results");
    list.replaceChildren();
    if (!items.length) { list.append(element("p", "command-empty", "Eşleşen bölüm yok.")); return; }
    items.forEach((item, index) => {
      const row = element("div");
      row.setAttribute("role", "listitem");
      const button = element("button", `command-item${index === commandIndex ? " selected" : ""}`);
      button.type = "button";
      button.dataset.view = item.view;
      const label = element("span", "command-item-text");
      label.append(element("strong", "", item.label), element("small", "", item.description));
      button.append(label, element("span", "command-arrow", "↵"));
      button.addEventListener("click", () => runCommand(item.view));
      button.addEventListener("focus", () => {
        commandIndex = index;
        list.querySelectorAll(".command-item").forEach((node, buttonIndex) => node.classList.toggle("selected", buttonIndex === index));
      });
      row.append(button);
      list.append(row);
    });
  }

  function openCommands() {
    if (!state.user || byId("command-dialog").open || document.querySelector("dialog[open]")) return;
    commandIndex = 0;
    byId("command-search").value = "";
    renderCommands();
    byId("command-dialog").showModal();
    byId("command-search").focus();
  }

  byId("nav-overview").addEventListener("click", () => selectView("overview"));
  byId("nav-models").addEventListener("click", () => selectView("models"));
  byId("nav-users").addEventListener("click", () => selectView("users"));
  byId("nav-playground")?.addEventListener("click", () => selectView("playground"));
  byId("nav-activity").addEventListener("click", () => selectView("activity"));
  byId("access-try-model").addEventListener("click", () => selectView("playground"));
  byId("next-activity").addEventListener("click", () => selectView("activity"));
  byId("usage-history-link").addEventListener("click", () => selectView("activity"));
  byId("setup-model").addEventListener("change", (event) => setModel(event.target.value));
  byId("aside-model-link").addEventListener("click", () => selectView("models"));
  byId("footer-key-link").addEventListener("click", (event) => {
    event.preventDefault();
    selectView("overview");
    requestAnimationFrame(() => byId("anahtar").scrollIntoView({ behavior: "smooth", block: "start" }));
  });
  document.querySelectorAll('a[href="#codex-setup"]').forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); selectView("setup"); }));
  byId("refresh-users").addEventListener("click", () => loadUsers({ force: true }));
  byId("user-search").addEventListener("input", renderUsers);
  byId("user-filter").addEventListener("change", renderUsers);
  byId("refresh-usage").addEventListener("click", () => refresh());
  byId("open-command").addEventListener("click", openCommands);
  byId("command-search").addEventListener("input", () => { commandIndex = 0; renderCommands(); });
  byId("command-dialog").addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      const buttons = [...byId("command-results").querySelectorAll(".command-item")];
      if (!buttons.length) return;
      event.preventDefault();
      if (document.activeElement === byId("command-search")) commandIndex = event.key === "ArrowDown" ? 0 : buttons.length - 1;
      else commandIndex = (commandIndex + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[commandIndex].focus();
    } else if (event.key === "Enter" && document.activeElement === byId("command-search")) {
      const item = filteredCommands()[commandIndex];
      if (item) { event.preventDefault(); runCommand(item.view); }
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openCommands();
    }
  });
  window.addEventListener("hashchange", () => { if (state.user) selectView(viewFromHash(), { historyMode: "none" }); });
  window.addEventListener("popstate", () => { if (state.user) selectView(viewFromHash(), { historyMode: "none" }); });
  document.addEventListener("visibilitychange", scheduleRefresh);
  byId("add-user").addEventListener("click", () => openUserDialog("create"));
  byId("user-form").addEventListener("submit", saveUser);
  byId("password-form").addEventListener("submit", changePassword);
  byId("change-password").addEventListener("click", () => { byId("password-form").reset(); byId("password-form-message").hidden = true; byId("password-dialog").showModal(); });
  byId("logout").addEventListener("click", logout);
  byId("retry-auth").addEventListener("click", authenticate);
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => byId(button.dataset.closeDialog).close()));
  for (const id of ["user-dialog", "password-dialog"]) byId(id).addEventListener("close", () => byId(id).querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; }));

  byId("create-key").addEventListener("click", () => openProjectKeys());
  byId("access-manage-keys").addEventListener("click", () => openProjectKeys());
  byId("manage-project-keys").addEventListener("click", () => openProjectKeys());
  byId("next-manage-keys").addEventListener("click", () => openProjectKeys());
  byId("project-key-form").addEventListener("submit", saveProjectKey);
  byId("cancel-key-rename").addEventListener("click", resetKeyEditor);
  byId("project-key-select").addEventListener("change", event => { const key = state.keys.find(key => (key.id || "legacy") === event.target.value); if (key) selectProjectKey(key); });
  byId("retry-keys").addEventListener("click", refresh);
  byId("rotate-key").addEventListener("click", () => openProjectKeys({ replacement: true }));
  byId("revoke-key").addEventListener("click", () => revokeKey());
  byId("reveal-key").addEventListener("click", () => { state.revealed = !state.revealed; renderSecret(); });
  byId("copy-key").addEventListener("click", () => { if (state.secret) copy(state.secret, "API anahtarın kopyalandı"); });
  document.querySelectorAll("[data-example-language]").forEach((button) => button.addEventListener("click", () => {
    if (!["curl", "javascript", "python"].includes(button.dataset.exampleLanguage)) return;
    state.exampleLanguage = button.dataset.exampleLanguage;
    updateExample();
  }));
  byId("copy-example").addEventListener("click", () => copy(exampleFor(state.secret && state.revealed ? state.secret : "YOUR_KEY"), "İstek örneği kopyalandı"));
  if (byId("copy-overview-code")) byId("copy-overview-code").addEventListener("click", () => copy(exampleFor(state.secret && state.revealed ? state.secret : "YOUR_KEY", state.exampleLanguage), "İstek örneği kopyalandı"));
  byId("copy-codex-config")?.addEventListener("click", () => copy(codexConfig(), configNotice("kopyalandı")));
  byId("download-codex-config")?.addEventListener("click", downloadCodexConfig);
  document.querySelectorAll("[data-copy-target]").forEach((button) => button.addEventListener("click", () => copy(byId(button.dataset.copyTarget).value, "Kopyalandı")));
  window.addEventListener("pagehide", (event) => {
    suspended = true;
    lifecycleRevision++;
    identityRevision++;
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    clearTimeout(toastTimeout);
    byId("toast").hidden = true;
    for (const controller of requestControllers) controller.abort();
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
    clearSensitiveKey();
    activity?.clear();
    if (byId("project-keys-dialog").open) byId("project-keys-dialog").close();
    for (const input of document.querySelectorAll('input[type="password"]')) input.value = "";
    if (state.key) renderSecret();
    else updateExample();
    if (!event.persisted) playground?.dispose?.();
  });
  window.addEventListener("pageshow", (event) => {
    suspended = false;
    if (event.persisted) {
      document.body.classList.add("auth-pending");
      byId("auth-cover").hidden = false;
      byId("auth-status").textContent = "Oturum yeniden kontrol ediliyor…";
      authenticate();
    } else scheduleRefresh();
  });
  activity = window.KlyActivity?.init?.({ api, onTry: () => selectView("playground"), onHealth: renderModelHealth });
  setBusy(false);
  authenticate();
})();

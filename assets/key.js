(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const state = { user: null, users: [], key: null, secret: null, revealed: false, busy: false, daily: 50, hourly: 20, weekly: 200, minute: 5, model: "gpt-6.1-sol", loaded: false, userMode: "create", view: "overview", usersLoadedAt: 0, lastRefreshAt: 0, lastRefreshAttempt: 0, stale: false, clockOffset: 0, resets: {}, remaining: {} };
  let toastTimeout;
  let refreshPromise;
  let usersPromise;
  let refreshTimer;
  let countdownTimer;
  let commandIndex = 0;
  const AUTO_REFRESH_MS = 60000;
  const USER_CACHE_MS = 30000;
  const MODEL_NAMES = Object.freeze({ "gpt-6.1-sol": "GPT 6.1 Sol", "gpt-6-astra": "GPT 6 Astra" });
  let modelCatalogSignature = "";
  let modelCatalog = [];

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
    if (byId("codex-config")) byId("codex-config").textContent = window.KlyCodexConfig.buildConfig(
      state.secret && state.revealed ? state.secret : undefined, state.model);
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
        for (const [label, value] of [["API yolu", "/api/v1/responses"], ["Uyumluluk", "Responses · Chat Completions"], ["Model kimliği", id]]) {
          const item = element("div");
          item.append(element("span", "", label), element("code", "", value));
          details.append(item);
        }
        const use = element("button", "button subtle", "Bu modelle kur");
        use.type = "button";
        use.addEventListener("click", () => { setModel(id); selectView("setup"); });
        const footer = element("div", "model-catalog-note");
        footer.append(element("span", "", item.note || "Yanıt süreleri ve araç desteği sağlayıcıya bağlıdır."), use);
        card.append(heading, details, footer);
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
  }

  function updateModelNote() {
    const selected = modelCatalog.find((model) => model.id === state.model);
    const needsBalance = selected?.availability === "balance_required";
    byId("setup-model-note").textContent = needsBalance ? selected.note || "Bu model için sağlayıcı hesabında özel bakiye gerekiyor." : "Seçimin yapılandırma dosyasına ve istek örneklerine uygulanır.";
    byId("setup-model-note").classList.toggle("warning", needsBalance);
  }

  function setModel(model) {
    if (!Object.hasOwn(MODEL_NAMES, model) || ![...byId("setup-model").options].some((option) => option.value === model)) return;
    state.model = model;
    byId("setup-model").value = model;
    byId("setup-selected-model").textContent = model;
    byId("model-id").value = model;
    updateModelNote();
    updateExample();
  }

  function render(data) {
    if (!data.key || (state.key && state.key.prefix !== data.key.prefix)) {
      state.secret = null;
      state.revealed = false;
    }
    state.key = data.key || null;
    state.daily = safeNumber(data.limits?.daily_requests ?? data.key?.daily_limit, 50);
    state.hourly = safeNumber(data.limits?.hourly_requests ?? data.key?.hourly_limit, 20);
    state.weekly = safeNumber(data.limits?.weekly_requests ?? data.key?.weekly_limit, 200);
    state.minute = safeNumber(data.limits?.requests_per_minute, 5);
    renderModels(data.service);
    state.loaded = true;
    const usage = safeNumber(state.key?.used_today ?? data.usage?.used_today, 0);
    const remaining = safeNumber(state.key?.remaining_today ?? data.usage?.remaining_today, Math.max(0, state.daily - usage));
    const hourlyUsage = safeNumber(data.usage?.used_this_hour ?? state.key?.used_this_hour, 0);
    const hourlyRemaining = safeNumber(data.usage?.remaining_this_hour ?? state.key?.remaining_this_hour, Math.max(0, state.hourly - hourlyUsage));
    const weeklyUsage = safeNumber(data.usage?.used_this_week ?? state.key?.used_this_week, 0);
    const weeklyRemaining = safeNumber(data.usage?.remaining_this_week ?? state.key?.remaining_this_week, Math.max(0, state.weekly - weeklyUsage));
    const serverTime = Date.parse(data.usage?.server_time || data.server_time);
    state.clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
    state.resets = { hour: Date.parse(data.usage?.hour_resets_at), day: Date.parse(data.usage?.day_resets_at), week: Date.parse(data.usage?.week_resets_at) };
    state.remaining = { hour: hourlyRemaining, day: remaining, week: weeklyRemaining };
    state.lastRefreshAt = Date.now();
    state.lastRefreshAttempt = state.lastRefreshAt;
    state.stale = false;

    byId("daily-limit").textContent = formattedNumber(state.daily);
    byId("empty-daily-limit").textContent = formattedNumber(state.daily);
    byId("minute-limit").textContent = formattedNumber(state.minute);
    byId("usage-count").textContent = formattedNumber(usage);
    byId("model-id").value = state.model;
    byId("remaining-label").textContent = `${formattedNumber(remaining)} istek kaldı · Her gün yenilenir`;
    byId("usage-progress").max = state.daily || 1;
    byId("usage-progress").value = usage;
    byId("hourly-limit").textContent = formattedNumber(state.hourly);
    byId("hourly-usage-count").textContent = formattedNumber(hourlyUsage);
    byId("hourly-remaining-label").textContent = `${formattedNumber(hourlyRemaining)} istek kaldı · Her saat yenilenir`;
    byId("hourly-progress").max = state.hourly || 1;
    byId("hourly-progress").value = hourlyUsage;
    byId("weekly-limit").textContent = formattedNumber(state.weekly);
    byId("weekly-usage-count").textContent = formattedNumber(weeklyUsage);
    byId("weekly-remaining-label").textContent = `${formattedNumber(weeklyRemaining)} istek kaldı · Her hafta yenilenir`;
    byId("weekly-progress").max = state.weekly || 1;
    byId("weekly-progress").value = weeklyUsage;
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
    const rows = [["day", "remaining-label", "Her gün yenilenir"], ["hour", "hourly-remaining-label", "Her saat yenilenir"], ["week", "weekly-remaining-label", "Her hafta yenilenir"]];
    for (const [period, id, fallback] of rows) {
      const reset = state.resets[period];
      const when = Number.isFinite(reset) ? reset <= now ? "Yenilenme zamanı geldi" : `${durationLabel(reset - now)} sonra yenilenir` : fallback;
      byId(id).textContent = `${formattedNumber(state.remaining[period])} istek kaldı · ${when}`;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    if (document.hidden || state.view !== "overview" || !state.user || !state.loaded) return;
    countdownTimer = setInterval(updateUsageClock, 15000);
    const delay = Math.max(1000, AUTO_REFRESH_MS - (Date.now() - state.lastRefreshAttempt));
    refreshTimer = setTimeout(() => refresh({ background: true }), delay);
  }

  async function request(method) {
    return api("/api/keys", method, method === "GET" ? undefined : {});
  }

  async function api(url, method = "GET", payload) {
    const controller = new AbortController();
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
    if (response.status === 401 && url !== "/api/auth") {
      state.user = null;
      state.secret = null;
      state.revealed = false;
      if (state.key) renderSecret();
      updateExample();
      scheduleRefresh();
      window.location.replace("/login");
      throw Object.assign(new Error("Oturumun sona erdi. Yeniden giriş yap."), { status: 401 });
    }
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
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Sunucu yanıtı gecikti. Yeniden deneyebilirsin.");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function refresh({ background = false, allowBusy = false } = {}) {
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

  async function createKey() {
    if (refreshPromise) await refreshPromise;
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
    if (refreshPromise) await refreshPromise;
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
      updateExample();
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
      await refresh({ allowBusy: true });
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
    if (hash === "#users") return "users";
    if (["#setup", "#codex-setup", "#baslarken"].includes(hash)) return "setup";
    return "overview";
  }

  function selectView(view, { historyMode = "push", focus = true } = {}) {
    if (!["overview", "models", "setup", "users"].includes(view)) view = "overview";
    if (view === "users" && state.user?.role !== "admin") view = "overview";
    const changed = state.view !== view;
    state.view = view;
    const users = view === "users";
    const models = view === "models";
    const setup = view === "setup";
    byId("overview-view").hidden = users || models || setup;
    byId("models-view").hidden = !models;
    byId("users-view").hidden = !users;
    byId("setup-view").hidden = !setup;
    byId("nav-overview").classList.toggle("current", !users && !models && !setup);
    byId("nav-models").classList.toggle("current", models);
    byId("nav-start").classList.toggle("current", setup);
    byId("nav-users").classList.toggle("current", users);
    for (const [id, active] of [["nav-overview", view === "overview"], ["nav-models", models], ["nav-start", setup], ["nav-users", users]]) {
      if (active) byId(id).setAttribute("aria-current", "page");
      else byId(id).removeAttribute("aria-current");
    }
    byId("breadcrumb-page").textContent = users ? "Kullanıcılar" : models ? "Modeller" : setup ? "Kurulum" : "Genel bakış";
    document.title = `${users ? "Kullanıcılar" : models ? "Modeller" : setup ? "Kurulum" : "API Anahtarın"} · KlyAPI`;
    const hash = `#${view}`;
    if (historyMode !== "none" && window.location.hash !== hash) window.history[historyMode === "replace" ? "replaceState" : "pushState"](null, "", hash);
    if (changed && focus) {
      const heading = byId(users ? "users-title" : models ? "models-title" : setup ? "start-heading" : "page-title");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    if (users) loadUsers();
    scheduleRefresh();
  }

  async function authenticate() {
    byId("retry-auth").hidden = true;
    try {
      const data = await api("/api/account");
      if (!data.user) { window.location.replace("/login"); return; }
      state.user = data.user;
      for (const id of ["sidebar-user", "account-name"]) byId(id).textContent = data.user.username;
      for (const id of ["sidebar-avatar", "account-avatar"]) byId(id).textContent = data.user.username.slice(0, 1).toUpperCase();
      byId("sidebar-role").textContent = data.user.role === "admin" ? "Yönetici" : "Kullanıcı";
      byId("nav-users").hidden = data.user.role !== "admin";
      byId("auth-cover").hidden = true;
      document.body.classList.remove("auth-pending");
      render(data);
      selectView(viewFromHash(), { historyMode: "replace", focus: false });
    } catch (error) {
      if (error.status === 401) { window.location.replace("/login"); return; }
      byId("auth-status").textContent = "Oturum bilgisi alınamadı. Yeniden deneyebilirsin.";
      byId("retry-auth").hidden = false;
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, action, disabled = false) {
    const button = element("button", "button subtle", label);
    button.type = "button";
    button.disabled = disabled;
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
      limits.append(element("span", "", `${formattedNumber(user.hourly_limit ?? 20)} / saat`), element("span", "", `${formattedNumber(user.daily_limit)} / gün`), element("span", "", `${formattedNumber(user.weekly_limit ?? 200)} / hafta`), element("span", "", `${formattedNumber(user.requests_per_minute)} / dakika`));
      const status = element("span", `user-state${user.enabled ? "" : " disabled"}`);
      status.append(element("span"), document.createTextNode(user.enabled ? "Aktif" : "Kapalı"));
      const own = user.username.toLowerCase() === state.user.username.toLowerCase();
      const actions = element("div", "user-actions");
      actions.append(actionButton("Kotalar", () => openUserDialog("quota", user)),
        actionButton("Şifre sıfırla", () => openUserDialog("password", user), own),
        actionButton(user.enabled ? "Erişimi kapat" : "Erişimi aç", () => toggleUser(user), user.role === "admin" || own));
      row.append(identity, limits, status, actions);
      fragment.append(row);
    }
    list.append(fragment);
  }

  async function loadUsers({ force = false } = {}) {
    if (state.user?.role !== "admin") return;
    if (usersPromise) {
      await usersPromise;
      if (!force) return;
    }
    if (!force && state.usersLoadedAt && Date.now() - state.usersLoadedAt < USER_CACHE_MS) { renderUsers(); return; }
    byId("users-message").hidden = true;
    byId("users-loading").hidden = Boolean(state.usersLoadedAt);
    byId("refresh-users").disabled = true;
    usersPromise = (async () => {
    try {
      const data = await api("/api/users");
      state.users = Array.isArray(data.users) ? data.users : [];
      state.usersLoadedAt = Date.now();
      renderUsers();
    } catch (error) { showFormMessage("users-message", error.message); }
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
    for (const id of ["user-daily", "user-hourly", "user-weekly", "user-minute"]) byId(id).disabled = mode === "password";
    byId("user-daily").value = user?.daily_limit ?? 50;
    byId("user-hourly").value = user?.hourly_limit ?? 20;
    byId("user-weekly").value = user?.weekly_limit ?? 200;
    byId("user-minute").value = user?.requests_per_minute ?? 5;
    byId("user-dialog-title").textContent = mode === "create" ? "Kullanıcı ekle" : mode === "quota" ? "Kullanım kotaları" : "Şifreyi sıfırla";
    byId("user-dialog-description").textContent = mode === "create" ? "Yeni kullanıcıya bir kullanıcı adı ve şifre belirle." : mode === "quota" ? "Bu hesaba ait anahtarların kullanım sınırlarını güncelle." : "Kullanıcının eski şifresi geçersiz olacak. Yeni şifreyi güvenli bir kanaldan ilet.";
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
      payload.daily_limit = Number(byId("user-daily").value);
      payload.hourly_limit = Number(byId("user-hourly").value);
      payload.weekly_limit = Number(byId("user-weekly").value);
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
      state.secret = null;
      state.revealed = false;
      if (state.key) renderSecret();
      updateExample();
      scheduleRefresh();
      window.location.replace("/login");
    } catch (error) { announce(error.message); byId("logout").disabled = false; }
  }

  const commandViews = [
    { view: "overview", label: "Genel bakış", description: "API anahtarı ve kullanım", icon: "i-key" },
    { view: "models", label: "Modeller", description: "Kullanılabilir model bilgileri", icon: "i-code" },
    { view: "setup", label: "Kurulum", description: "Codex yapılandırması ve API bağlantısı", icon: "i-desktop" },
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

  byId("create-key").addEventListener("click", createKey);
  byId("retry-keys").addEventListener("click", refresh);
  byId("rotate-key").addEventListener("click", () => revokeKey(true));
  byId("revoke-key").addEventListener("click", () => revokeKey(false));
  byId("reveal-key").addEventListener("click", () => { state.revealed = !state.revealed; renderSecret(); });
  byId("copy-key").addEventListener("click", () => { if (state.secret) copy(state.secret, "API anahtarın kopyalandı"); });
  byId("copy-example").addEventListener("click", () => copy(exampleFor(state.secret || "YOUR_KEY"), "İstek örneği kopyalandı"));
  byId("copy-codex-config")?.addEventListener("click", () => copy(codexConfig(), configNotice("kopyalandı")));
  byId("download-codex-config")?.addEventListener("click", downloadCodexConfig);
  document.querySelectorAll("[data-copy-target]").forEach((button) => button.addEventListener("click", () => copy(byId(button.dataset.copyTarget).value, "Kopyalandı")));
  window.addEventListener("pagehide", () => {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
    state.secret = null;
    state.revealed = false;
    if (state.key) renderSecret();
    else updateExample();
  });
  window.addEventListener("pageshow", scheduleRefresh);
  setBusy(false);
  authenticate();
})();

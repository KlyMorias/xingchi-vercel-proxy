(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const state = { user: null, users: [], key: null, secret: null, revealed: false, busy: false, daily: 50, minute: 5, model: "gpt-6.1-sol", loaded: false, userMode: "create" };
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
    if (byId("codex-config")) byId("codex-config").textContent = window.KlyCodexConfig.buildConfig(
      state.secret && state.revealed ? state.secret : undefined);
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
    const usage = safeNumber(state.key?.used_today ?? data.usage?.used_today, 0);
    const remaining = safeNumber(state.key?.remaining_today ?? data.usage?.remaining_today, Math.max(0, state.daily - usage));

    byId("daily-limit").textContent = formattedNumber(state.daily);
    byId("empty-daily-limit").textContent = formattedNumber(state.daily);
    byId("minute-limit").textContent = formattedNumber(state.minute);
    byId("usage-count").textContent = formattedNumber(usage);
    byId("model-name").textContent = state.model;
    byId("model-id").value = state.model;
    byId("remaining-label").textContent = `${formattedNumber(remaining)} istek kaldı · Her gün yenilenir`;
    byId("usage-progress").max = state.daily || 1;
    byId("usage-progress").value = usage;
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
    return api("/api/keys", method, method === "GET" ? undefined : {});
  }

  async function api(url, method = "GET", payload) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (response.status === 401 && url !== "/api/auth") {
      state.secret = null;
      state.revealed = false;
      updateExample();
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

  function codexConfig() {
    return window.KlyCodexConfig.buildConfig(state.secret || undefined);
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

  function selectView(view) {
    const users = view === "users" && state.user?.role === "admin";
    byId("overview-view").hidden = users;
    byId("users-view").hidden = !users;
    byId("baslarken").hidden = users;
    byId("nav-overview").classList.toggle("current", !users);
    byId("nav-users").classList.toggle("current", users);
    byId("breadcrumb-page").textContent = users ? "Kullanıcılar" : "Genel bakış";
    if (users) loadUsers();
  }

  async function authenticate() {
    byId("retry-auth").hidden = true;
    try {
      const data = await api("/api/auth");
      if (!data.user) { window.location.replace("/login"); return; }
      state.user = data.user;
      for (const id of ["sidebar-user", "account-name"]) byId(id).textContent = data.user.username;
      for (const id of ["sidebar-avatar", "account-avatar"]) byId(id).textContent = data.user.username.slice(0, 1).toUpperCase();
      byId("sidebar-role").textContent = data.user.role === "admin" ? "Yönetici" : "Kullanıcı";
      byId("nav-users").hidden = data.user.role !== "admin";
      byId("auth-cover").hidden = true;
      document.body.classList.remove("auth-pending");
      fetch("/api", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
        .then((service) => { if (service) renderService(service); }).catch(() => {});
      refresh();
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
    if (!state.users.length) { list.append(element("p", "users-empty", "Henüz kullanıcı bulunmuyor.")); return; }
    for (const user of state.users) {
      const row = element("article", "user-row");
      const identity = element("div", "user-identity");
      identity.append(element("span", "user-avatar", user.username.slice(0, 1).toUpperCase()));
      const info = element("div");
      const name = element("strong", "user-name", user.username);
      if (user.role === "admin") name.append(element("span", "user-role", "YÖNETİCİ"));
      info.append(name, element("span", "user-created", dateLabel(user.created_at) || "Hesap oluşturuldu"));
      identity.append(info);
      const limits = element("div", "user-limits");
      limits.append(element("span", "", `${formattedNumber(user.daily_limit)} istek / gün`), element("span", "", `${formattedNumber(user.requests_per_minute)} istek / dakika`));
      const status = element("span", `user-state${user.enabled ? "" : " disabled"}`);
      status.append(element("span"), document.createTextNode(user.enabled ? "Aktif" : "Kapalı"));
      const own = user.username.toLowerCase() === state.user.username.toLowerCase();
      const actions = element("div", "user-actions");
      actions.append(actionButton("Kotalar", () => openUserDialog("quota", user)),
        actionButton("Şifre sıfırla", () => openUserDialog("password", user), own),
        actionButton(user.enabled ? "Erişimi kapat" : "Erişimi aç", () => toggleUser(user), user.role === "admin" || own));
      row.append(identity, limits, status, actions);
      list.append(row);
    }
  }

  async function loadUsers() {
    if (state.user?.role !== "admin") return;
    byId("users-message").hidden = true;
    byId("users-loading").hidden = false;
    byId("refresh-users").disabled = true;
    try {
      const data = await api("/api/users");
      state.users = Array.isArray(data.users) ? data.users : [];
      renderUsers();
    } catch (error) { showFormMessage("users-message", error.message); }
    finally { byId("users-loading").hidden = true; byId("refresh-users").disabled = false; }
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
    for (const id of ["user-daily", "user-minute"]) byId(id).disabled = mode === "password";
    byId("user-daily").value = user?.daily_limit ?? 50;
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
      await loadUsers();
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
      await loadUsers();
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
      state.secret = null;
      state.revealed = false;
      updateExample();
      window.location.replace("/login");
    } catch (error) { announce(error.message); byId("logout").disabled = false; }
  }

  byId("nav-overview").addEventListener("click", () => selectView("overview"));
  byId("nav-users").addEventListener("click", () => selectView("users"));
  byId("nav-start").addEventListener("click", () => selectView("overview"));
  byId("refresh-users").addEventListener("click", loadUsers);
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
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
    state.secret = null;
    state.revealed = false;
    if (state.key) renderSecret();
    else updateExample();
  });
  setBusy(false);
  authenticate();
})();

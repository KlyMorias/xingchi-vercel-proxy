(() => {
  "use strict";
  const form = document.getElementById("login-form");
  const username = document.getElementById("login-username");
  const password = document.getElementById("login-password");
  const button = document.getElementById("login-submit");
  const message = document.getElementById("login-message");
  const toggle = document.getElementById("toggle-password");
  let busy = false;
  function setPasswordVisible(visible) {
    password.type = visible ? "text" : "password";
    toggle.setAttribute("aria-label", visible ? "Şifreyi gizle" : "Şifreyi göster");
    toggle.setAttribute("aria-pressed", String(visible));
  }
  toggle.addEventListener("click", () => setPasswordVisible(password.type === "password"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    message.hidden = true;
    button.disabled = true;
    button.querySelector("span").textContent = "Giriş yapılıyor…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/auth", { method: "POST", credentials: "same-origin", signal: controller.signal, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ action: "login", username: username.value.trim(), password: password.value }) });
      let body;
      try { body = await response.json(); } catch { throw new Error("Giriş servisine ulaşılamadı. Biraz sonra yeniden dene."); }
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message || "Giriş yapılamadı. Bilgilerini kontrol et.");
      password.value = "";
      window.location.replace("/key");
    } catch (error) {
      message.textContent = error.name === "AbortError" ? "Giriş isteği zaman aşımına uğradı. Yeniden deneyebilirsin." : error.message || "Bağlantı kurulamadı. Yeniden dene.";
      message.hidden = false;
    } finally {
      clearTimeout(timeout);
      busy = false;
      button.disabled = false;
      button.querySelector("span").textContent = "Giriş yap";
    }
  });
  fetch("/api/auth", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
    .then((response) => { if (response.ok) window.location.replace("/key"); }).catch(() => {});
  window.addEventListener("pagehide", () => { password.value = ""; setPasswordVisible(false); });
})();

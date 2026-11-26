(() => {
  "use strict";
  const STATUSES = Object.freeze({ success: "Başarılı", error: "Hata", cancelled: "İptal", unknown: "Belirsiz", in_progress: "Sürüyor" });
  const count = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat("tr-TR").format(value) : "—";
  const date = value => {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short" }).format(parsed) : "—";
  };
  function init({ api, onTry, onHealth = () => {} }) {
    const $ = id => document.getElementById(id);
    let revision = 0, busy = false, cursor = null, rows = [], loadedAt = 0, health = [], healthAt = 0, appliedQuery = "", exporting = false;
    const node = (tag, className, text) => {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const filters = () => {
      const params = new URLSearchParams();
      for (const [id, name] of [["activity-from", "from"], ["activity-to", "to"], ["activity-model", "model"], ["activity-key", "key_id"], ["activity-status", "status"]]) {
        const value = $(id).value;
        if (value) params.set(name, value);
      }
      return params;
    };
    function options(id, items, title, selected) {
      const select = $(id);
      select.replaceChildren(node("option", "", title));
      select.options[0].value = "";
      for (const item of items) {
        const option = node("option", "", typeof item === "string" ? item : item.name);
        option.value = typeof item === "string" ? item : item.id;
        select.append(option);
      }
      select.value = selected;
      if (select.selectedIndex < 0) select.value = "";
    }
    function renderRows() {
      $("activity-rows").replaceChildren();
      for (const item of rows) {
        const row = node("tr");
        const cell = (label, ...children) => {
          const el = node("td");
          el.dataset.label = label;
          el.append(...children);
          row.append(el);
          return el;
        };
        const detail = node("details", "request-identifiers");
        detail.append(node("summary", "", date(item.started_at)));
        const ids = node("div");
        ids.append(node("span", "", "İstek kimliği"), node("code", "", item.id || "—"));
        if (item.response_id) ids.append(node("span", "", "Sağlayıcı yanıtı"), node("code", "", item.response_id));
        detail.append(ids);
        cell("Zaman / Kimlik", detail);
        cell("Model / API", node("strong", "", item.model || "Bildirilmedi"), node("small", "", item.endpoint || "—"));
        cell("Proje", node("strong", "", item.key_name || "Önceki anahtar"));
        const status = Object.hasOwn(STATUSES, item.status) ? item.status : "unknown";
        const statusCell = cell("Durum", node("span", "request-status", STATUSES[status]));
        statusCell.firstElementChild.dataset.state = status;
        if (item.http_status) statusCell.append(node("small", "", `HTTP ${item.http_status}`));
        if (item.error_code) statusCell.append(node("code", "request-error-code", item.error_code));
        if (item.usage_status === "unavailable") statusCell.append(node("small", "", "Tokenlar doğrulanamadı"));
        if (item.usage_status === "not_started") statusCell.append(node("small", "", "Üretim başlamadı"));
        const duration = typeof item.latency_ms === "number" && Number.isFinite(item.latency_ms) && item.latency_ms >= 0
          ? item.latency_ms < 1000 ? `${Math.round(item.latency_ms)} ms` : `${(item.latency_ms / 1000).toLocaleString("tr-TR", {maximumFractionDigits: 2})} sn` : "—";
        cell("Süre", node("span", "", duration));
        for (const [label, key] of [["Giriş", "input_tokens"], ["Çıkış", "output_tokens"], ["Toplam", "total_tokens"]]) {
          const value = node("span", "request-tokens", count(item[key]));
          if (value.textContent === "—") value.title = "Doğrulanmış token sayısı yok; sıfır olarak kabul edilmez.";
          cell(label, value);
        }
        $("activity-rows").append(row);
      }
      $("activity-table-wrap").hidden = !rows.length;
      $("activity-empty").hidden = Boolean(rows.length);
      $("activity-more").hidden = !cursor;
    }
    function setBusy(value) {
      busy = value;
      $("activity-panel")?.setAttribute("aria-busy", String(value));
      for (const id of ["activity-refresh", "activity-more", "activity-reset"]) $(id).disabled = value;
      $("activity-filters").querySelector('button[type="submit"]').disabled = value;
      $("activity-filters").querySelectorAll("input,select").forEach(input => { input.disabled = value; });
      updateDraftState();
    }
    function updateDraftState() {
      const dirty = Boolean(loadedAt && filters().toString() !== appliedQuery);
      $("activity-more").disabled = busy || dirty;
      $("activity-export").disabled = busy || dirty || exporting;
      $("activity-filter-status").hidden = !dirty;
      $("activity-filter-status").textContent = dirty ? "Filtreler değişti. Sonuçları ve dışa aktarılacak kayıtları güncellemek için Filtrele’ye bas." : "";
    }
    async function load({ more = false, force = false } = {}) {
      if (busy || (!force && !more && loadedAt && Date.now() - loadedAt < 30000)) return;
      const query = more ? new URLSearchParams(appliedQuery) : filters();
      if (query.get("from") && query.get("to") && query.get("from") > query.get("to")) {
        $("activity-error").textContent = "Başlangıç tarihi bitiş tarihinden sonra olamaz.";
        $("activity-error").hidden = false;
        return;
      }
      if (more && !cursor) return;
      if (more) query.set("cursor", cursor);
      query.set("limit", "25");
      const own = ++revision;
      setBusy(true);
      $("activity-error").hidden = true;
      if (!loadedAt) $("activity-count").textContent = "Kayıtlar yükleniyor…";
      try {
        const data = await api(`/api/activity?${query}`);
        if (own !== revision) return;
        if (!Array.isArray(data.items)) throw new Error("İstek kayıtları okunamadı.");
        rows = more ? [...rows, ...data.items.filter(item => !rows.some(row => row.id === item.id))] : data.items;
        cursor = data.next_cursor || null;
        loadedAt = Date.now();
        const applied = new URLSearchParams(query);
        applied.delete("cursor"); applied.delete("limit");
        appliedQuery = applied.toString();
        options("activity-model", data.filters?.models || [], "Tüm modeller", query.get("model") || "");
        options("activity-key", data.filters?.keys || [], "Tüm projeler", query.get("key_id") || "");
        $("activity-count").textContent = `${count(rows.length)} / ${count(data.total)} kayıt · Saatler cihazının yerel saatinde`;
        $("activity-retention").textContent = data.retention?.notice || "Son 30 gün, hesap başına en fazla 200 kayıt saklanır.";
        const filtered = [...filters().keys()].length > 0;
        $("activity-empty-text").textContent = filtered ? "Bu filtrelerle eşleşen kayıt yok. Tarih aralığını genişlet veya filtreleri temizle." : "Bu sürümden sonraki üretim isteklerin burada görünecek. Eski isteklerin ayrıntıları içe aktarılmaz.";
        health = Array.isArray(data.model_health) ? data.model_health : [];
        healthAt = loadedAt;
        onHealth(health);
        renderRows();
      } catch (error) {
        if (own !== revision || error.code === "page_inactive") return;
        $("activity-error").textContent = error.message;
        $("activity-error").hidden = false;
        if (!loadedAt) $("activity-count").textContent = "Kayıtlar alınamadı. Yeniden deneyebilirsin.";
      } finally { if (own === revision) setBusy(false); }
    }
    async function loadHealth() {
      if (healthAt && Date.now() - healthAt < 60000) { onHealth(health); return; }
      const own = revision;
      try {
        const data = await api("/api/activity?limit=1");
        if (own !== revision) return;
        health = Array.isArray(data.model_health) ? data.model_health : [];
        healthAt = Date.now();
        onHealth(health);
      } catch (error) { if (own === revision && error.code !== "page_inactive") onHealth(null); }
    }
    async function exportCsv() {
      const button = $("activity-export");
      exporting = true;
      button.disabled = true;
      const own = revision;
      let url;
      try {
        const query = new URLSearchParams(loadedAt ? appliedQuery : filters());
        query.set("format", "csv");
        const text = await api(`/api/activity?${query}`, "GET", undefined, { responseType: "text" });
        if (own !== revision) return;
        url = URL.createObjectURL(new Blob([text], {type: "text/csv;charset=utf-8"}));
        const link = node("a");
        link.href = url;
        link.download = `klyapi-istekler-${new Date().toISOString().slice(0,10)}.csv`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      } catch (error) {
        if (error.code !== "page_inactive" && own === revision) { $("activity-error").textContent = error.message; $("activity-error").hidden = false; }
      } finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); exporting = false; updateDraftState(); }
    }
    function clear() {
      revision++;
      rows = []; cursor = null; loadedAt = 0; health = []; healthAt = 0; appliedQuery = "";
      onHealth([]);
      $("activity-filters").reset();
      options("activity-model", [], "Tüm modeller", "");
      options("activity-key", [], "Tüm projeler", "");
      $("activity-rows").replaceChildren();
      $("activity-table-wrap").hidden = true;
      $("activity-empty").hidden = true;
      $("activity-error").hidden = true;
      $("activity-more").hidden = true;
      $("activity-count").textContent = "Kayıtlar yükleniyor…";
      $("activity-retention").textContent = "Saklama bilgisi yükleniyor…";
      setBusy(false);
    }
    $("activity-filters").addEventListener("submit", event => { event.preventDefault(); load({ force: true }); });
    $("activity-filters").addEventListener("change", updateDraftState);
    $("activity-reset").addEventListener("click", () => { $("activity-filters").reset(); load({ force: true }); });
    $("activity-refresh").addEventListener("click", () => load({ force: true }));
    $("activity-more").addEventListener("click", () => load({ more: true }));
    $("activity-export").addEventListener("click", exportCsv);
    $("activity-try").addEventListener("click", onTry);
    return { load, clear, loadHealth, invalidate() { loadedAt = 0; healthAt = 0; } };
  }
  window.KlyActivity = Object.freeze({ init });
})();

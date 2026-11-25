(() => {
  "use strict";

  // Optional presentation only: no requests, stored state or account data.
  // Photo transforms belong to CSS and consume these wrapper-scoped px values:
  // --pointer-x, --pointer-y (±8px), --scroll-shift (±35px).
  const root = document.documentElement;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
  const revealSelector = "[data-reveal], .usage-overview, .dashboard-grid > .panel, .connection-shortcut, .connection-row, .model-catalog-card, .codex-setup-card";
  const photoSelector = ".cinematic-hero, .auth-visual";
  const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "FORM", "DIALOG"]);
  const seen = new WeakSet();
  let active = false;
  let suspended = false;
  let frame = 0;
  let scanRequested = false;
  let revealObserver;
  let catalogObserver;
  const photos = new Map();
  const pending = new Set();
  const managed = new Set();
  let removeListeners = [];

  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
  const viewportHeight = () => window.innerHeight || root.clientHeight;
  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    removeListeners.push(() => target.removeEventListener(type, callback, options));
  }
  function visibleBox(node) {
    if (!node.isConnected || node.closest("[hidden], [inert]")) return null;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height || !node.getClientRects().length) return null;
    const style = window.getComputedStyle(node);
    return style.visibility === "hidden" || style.display === "none" ? null : box;
  }
  function clearPhoto(node) {
    for (const property of ["--pointer-x", "--pointer-y", "--scroll-shift"]) node.style.removeProperty(property);
  }
  function finishEntrance() {
    // This flag survives motion suspension. CSS settles only the introductory
    // shutter/text, while ambient photo and ribbon movement may resume.
    root.classList.add("motion-entered");
  }
  function entranceEnded(event) {
    if (event.animationName !== "soft-arrival" || event.pseudoElement
        || !event.target?.matches?.(".hero-bottom, .auth-visual-copy")
        || document.body?.classList.contains("auth-pending") || !visibleBox(event.target)) return;
    finishEntrance();
  }
  function reveal(node) {
    node.classList.remove("reveal-pending");
    node.classList.add("is-visible");
    managed.add(node);
    pending.delete(node);
    seen.add(node);
    revealObserver?.unobserve(node);
  }
  function scan() {
    for (const node of document.querySelectorAll(photoSelector)) {
      if (photos.has(node) || !node.querySelector(".cinematic-image")) continue;
      const photo = { pointer: null };
      photos.set(node, photo);
      if (finePointer?.matches) {
        listen(node, "pointermove", (event) => {
          if (event.pointerType && !["mouse", "pen"].includes(event.pointerType)) return;
          photo.pointer = { x: event.clientX, y: event.clientY };
          schedule();
        }, { passive: true });
        listen(node, "pointerleave", () => { photo.pointer = null; schedule(); }, { passive: true });
      }
    }
    // The fallback remains fully visible when IntersectionObserver is absent.
    if (!revealObserver) return;
    for (const node of pending) {
      if (visibleBox(node)) continue;
      node.classList.remove("reveal-pending", "is-visible");
      revealObserver.unobserve(node);
      pending.delete(node);
    }
    for (const node of document.querySelectorAll(revealSelector)) {
      if (seen.has(node) || pending.has(node) || interactiveTags.has(node.tagName)
          || node.closest("form, dialog") || node.querySelector("form")) continue;
      const box = visibleBox(node);
      if (!box) continue;
      if (box.top < viewportHeight()) { seen.add(node); continue; }
      node.classList.add("reveal-pending");
      managed.add(node);
      pending.add(node);
      revealObserver.observe(node);
    }
  }
  function updatePhotos() {
    const height = viewportHeight();
    for (const [node, photo] of photos) {
      // Geometry is enough for presentation visibility. Inherited visibility is
      // initially hidden behind the auth cover; that cover already pauses CSS.
      const box = node.isConnected && !node.closest("[hidden], [inert]") ? node.getBoundingClientRect() : null;
      const inView = box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < height;
      if (inView) node.classList.add("motion-in-view");
      else node.classList.remove("motion-in-view");
      if (!inView || !finePointer?.matches) { clearPhoto(node); continue; }
      const x = photo.pointer ? clamp(((photo.pointer.x - box.left) / box.width - 0.5) * 16, 8) : 0;
      const y = photo.pointer ? clamp(((photo.pointer.y - box.top) / box.height - 0.5) * 16, 8) : 0;
      const scroll = clamp((height / 2 - box.top - box.height / 2) * 0.075, 35);
      node.style.setProperty("--pointer-x", `${x.toFixed(2)}px`);
      node.style.setProperty("--pointer-y", `${y.toFixed(2)}px`);
      node.style.setProperty("--scroll-shift", `${scroll.toFixed(2)}px`);
    }
  }
  function schedule(shouldScan = false) {
    if (!active || document.hidden) return;
    scanRequested = scanRequested || shouldScan;
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!active || document.hidden) return;
      if (scanRequested) { scanRequested = false; scan(); }
      updatePhotos();
      // No recurring frame: only real input or a scoped DOM change schedules.
    });
  }
  function stop() {
    // Finish an interrupted, already exposed entrance rather than remasking
    // content on return. A hero still behind the auth gate has not entered.
    if (active && !document.body?.classList.contains("auth-pending")) finishEntrance();
    active = false;
    root.classList.remove("has-motion");
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    scanRequested = false;
    revealObserver?.disconnect();
    catalogObserver?.disconnect();
    revealObserver = catalogObserver = undefined;
    for (const remove of removeListeners) remove();
    removeListeners = [];
    for (const node of managed) {
      node.classList.remove("reveal-pending", "is-visible");
      seen.add(node);
    }
    managed.clear();
    pending.clear();
    for (const node of photos.keys()) { clearPhoto(node); node.classList.remove("motion-in-view"); }
    photos.clear();
  }
  function start() {
    if (active || suspended || document.hidden || !reduced || !window.requestAnimationFrame) return;
    // A page first viewed with reduced motion stays exposed if that preference
    // changes later in the same session.
    if (reduced.matches) { finishEntrance(); return; }
    active = true;
    root.classList.add("has-motion");
    if (window.IntersectionObserver) {
      revealObserver = new window.IntersectionObserver((entries) => {
        if (!active) return;
        for (const entry of entries) if (entry.isIntersecting && pending.has(entry.target)) reveal(entry.target);
      }, { threshold: 0.05, rootMargin: "0px 0px -24px 0px" });
    }
    scan();
    updatePhotos();
    listen(window, "scroll", () => schedule(), { passive: true });
    listen(window, "resize", () => schedule(true), { passive: true });
    listen(window, "hashchange", () => schedule(true));
    listen(window, "popstate", () => schedule(true));
    listen(document, "animationend", entranceEnded);
    // pushState-based tab changes do not emit hashchange. Scan after the
    // application's click/keyboard handlers have made the target view visible.
    listen(document, "click", (event) => { if (event.target?.closest?.("a, button")) schedule(true); });
    listen(document, "keydown", (event) => { if (["Enter", "Escape"].includes(event.key)) schedule(true); });
    const catalog = document.getElementById("model-catalog");
    if (catalog && window.MutationObserver) {
      catalogObserver = new window.MutationObserver(() => schedule(true));
      catalogObserver.observe(catalog, { childList: true });
    }
  }
  function preferenceChanged() { stop(); start(); }
  for (const media of [reduced, finePointer]) {
    if (media?.addEventListener) media.addEventListener("change", preferenceChanged);
    else media?.addListener?.(preferenceChanged);
  }
  window.addEventListener("pagehide", () => { suspended = true; stop(); });
  window.addEventListener("pageshow", () => { suspended = false; start(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else start(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

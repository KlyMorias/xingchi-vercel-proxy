// A hold limits admission, while its longer-lived ticket permits late actual
// usage to reconcile. Neither value is ever charged as provider consumption.
const HOLD_SECONDS = 600;
const TICKET_SECONDS = 3600;
const RECEIPT_SECONDS = 600;

function unresolved(saved) {
  return saved.kind === "tokens" && !["settled", "released"].includes(saved.status);
}
function holdExpiry(saved) { return saved.hold_expires_at ?? saved.expires_at; }
function activeHold(saved, now) {
  return unresolved(saved) && saved.status !== "unknown" && holdExpiry(saved) > now;
}
function markUnknownInState(state, saved) {
  if (!unresolved(saved) || saved.status === "unknown") return;
  const usage = state.usage[saved.user_id];
  if (usage?.day === saved.day) {
    const count = (usage.unknown_requests_today ?? 0) + 1;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw Object.assign(new Error("Usage accounting is unavailable"), { statusCode: 503, code: "storage_unavailable" });
    }
    usage.unknown_requests_today = count;
  }
  saved.status = "unknown";
}
function expireAccountingReservations(state, now) {
  for (const saved of Object.values(state.reservations || {})) {
    if (unresolved(saved) && holdExpiry(saved) <= now) markUnknownInState(state, saved);
    // Keep old-format tickets too: their original expiry was the hold expiry,
    // not evidence that a late provider settlement can safely be discarded.
    if (saved.kind === "tokens" && saved.hold_expires_at === undefined) {
      saved.hold_expires_at = saved.expires_at;
      saved.expires_at += TICKET_SECONDS - HOLD_SECONDS;
    }
  }
}

module.exports = { HOLD_SECONDS, TICKET_SECONDS, RECEIPT_SECONDS, unresolved, holdExpiry,
  activeHold, markUnknownInState, expireAccountingReservations };

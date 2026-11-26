// Metadata only. Never persist prompts, responses, credentials, request headers,
// provider error messages or IP addresses in the account activity log.
const { error } = require('./http');

const RETENTION_DAYS = 30;
const MAX_PER_ACCOUNT = 200;
const MAX_RECORDS = 2000;
const STATUSES = new Set(['in_progress', 'success', 'error', 'cancelled', 'unknown']);
const USAGE_STATUSES = new Set(['pending', 'verified', 'unavailable', 'not_started']);
const ENDPOINTS = new Set(['v1/responses', 'v1/chat/completions', 'v1/messages']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function iso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time <= 8640000000000000 ? new Date(time).toISOString() : null;
}
function keyName(value) {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.normalize('NFC').trim().slice(0, 48) || 'Kişisel anahtar' : 'Kişisel anahtar';
}
function history(state, create = false) {
  if (state.activity === undefined) {
    if (!create) return null;
    state.activity = { version: 1, accounts: {}, entries: {} };
  }
  const value = state.activity;
  if (!value || value.version !== 1 || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)
    || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw error(503, 'storage_unavailable', 'İstek geçmişi okunamıyor.');
  }
  return value;
}
function publicRecord(value, now = Date.now()) {
  const started = iso(value?.started_at);
  if (!requestId(value?.id) || !started || !ENDPOINTS.has(value.endpoint)) return null;
  let status = STATUSES.has(value.status) ? value.status : 'unknown';
  let usageStatus = USAGE_STATUSES.has(value.usage_status) ? value.usage_status : 'unavailable';
  // Reads must also be truthful before the next mutation persists cleanup.
  if (status === 'in_progress' && Date.parse(started) + 600000 <= now) {
    status = 'unknown'; usageStatus = 'unavailable';
  }
  const input = integer(value.input_tokens), output = integer(value.output_tokens);
  const validUsage = usageStatus === 'verified' && input !== null && output !== null && Number.isSafeInteger(input + output);
  return { id: value.id, key_id: identifier(value.key_id), key_name: keyName(value.key_name),
    started_at: started, completed_at: iso(value.completed_at), model: identifier(value.model), endpoint: value.endpoint,
    status, http_status: Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599 ? value.http_status : null,
    error_code: identifier(value.error_code), latency_ms: integer(value.latency_ms),
    usage_status: validUsage ? 'verified' : usageStatus === 'verified' ? 'unavailable' : usageStatus,
    input_tokens: validUsage ? input : null, output_tokens: validUsage ? output : null,
    total_tokens: validUsage ? input + output : null, response_id: identifier(value.response_id) };
}
function startRequest(state, details) {
  if (!requestId(details?.id) || typeof details.user_id !== 'string' || !ENDPOINTS.has(details.endpoint)) return;
  const started = iso(details.started_at) || new Date().toISOString();
  const saved = history(state, true);
  if (saved.entries[details.id]) return;
  if (!saved.accounts[details.user_id]) saved.accounts[details.user_id] = { started_at: started };
  saved.entries[details.id] = { id: details.id, user_id: details.user_id,
    key_id: identifier(details.key_id), key_name: keyName(details.key_name), model: identifier(details.model),
    endpoint: details.endpoint, started_at: started, completed_at: null, status: 'in_progress',
    usage_status: 'pending', http_status: null, error_code: null, latency_ms: null,
    input_tokens: null, output_tokens: null, total_tokens: null, response_id: null };
  cleanupHistory(state, Date.parse(started) / 1000);
}
function finishRequest(state, id, details = {}) {
  const saved = history(state)?.entries[id];
  if (!saved) return;
  // A retry/late terminal may improve unknown accounting, but an unverified
  // transport failure must not erase a verified terminal or its actual counts.
  const verified = integer(details.input_tokens) !== null && integer(details.output_tokens) !== null
    && Number.isSafeInteger(details.input_tokens + details.output_tokens);
  if (saved.usage_status === 'verified' && !verified) return;
  // Uncertain consumption is separate from a known failed/cancelled outcome.
  // Later ticket expiry must not replace an actual HTTP error with a timeout.
  if (!verified && details.status === 'unknown' && ['error', 'cancelled'].includes(saved.status)) return;
  if (STATUSES.has(details.status)) saved.status = details.status;
  if (verified) {
    saved.input_tokens = details.input_tokens; saved.output_tokens = details.output_tokens;
    saved.total_tokens = details.input_tokens + details.output_tokens; saved.usage_status = 'verified';
  } else if (USAGE_STATUSES.has(details.usage_status)) saved.usage_status = details.usage_status;
  else saved.usage_status = saved.status === 'in_progress' ? 'pending' : 'unavailable';
  if (Number.isInteger(details.http_status) && details.http_status >= 100 && details.http_status <= 599) saved.http_status = details.http_status;
  if (details.error_code !== undefined) saved.error_code = identifier(details.error_code);
  else if (saved.status === 'success') saved.error_code = null;
  if (integer(details.latency_ms) !== null) saved.latency_ms = details.latency_ms;
  if (details.response_id !== undefined) saved.response_id = identifier(details.response_id);
  saved.completed_at = iso(details.completed_at) || new Date().toISOString();
}
function cleanupHistory(state, nowSeconds = Date.now() / 1000) {
  const saved = history(state);
  if (!saved) return;
  const cutoff = (nowSeconds - RETENTION_DAYS * 86400) * 1000;
  const accountIds = new Set(Object.values(state.users || {}).map(user => user.id));
  const rows = Object.values(saved.entries).filter(row => requestId(row?.id)
    && accountIds.has(row.user_id) && Date.parse(row.started_at) >= cutoff)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
  const counts = new Map();
  const kept = {};
  let total = 0;
  for (const row of rows) {
    const count = counts.get(row.user_id) || 0;
    if (count >= MAX_PER_ACCOUNT || total >= MAX_RECORDS) continue;
    kept[row.id] = row; counts.set(row.user_id, count + 1); total++;
  }
  saved.entries = kept;
  for (const id of Object.keys(saved.accounts)) if (!accountIds.has(id)) delete saved.accounts[id];
}
function dateFilter(value, end = false) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error(400, 'invalid_filter', 'Tarih YYYY-AA-GG biçiminde olmalı.');
  const date = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value) throw error(400, 'invalid_filter', 'Geçerli bir tarih seç.');
  return date + (end ? 86400000 - 1 : 0);
}
function parseFilters(query = {}) {
  for (const key of Object.keys(query)) if (!['limit', 'cursor', 'model', 'key_id', 'status', 'from', 'to', 'format'].includes(key)) {
    throw error(400, 'invalid_filter', 'Desteklenmeyen filtre.');
  }
  const limit = query.limit === undefined ? 25 : typeof query.limit === 'string' && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, 'invalid_filter', 'Sayfa boyutu 1–100 olmalı.');
  const model = query.model === undefined || query.model === '' ? null : identifier(query.model);
  const key = query.key_id === undefined || query.key_id === '' ? null : identifier(query.key_id);
  if ((query.model && !model) || (query.key_id && !key)) throw error(400, 'invalid_filter', 'Geçersiz model veya anahtar filtresi.');
  const status = query.status === undefined || query.status === '' ? null : query.status;
  if (status !== null && !STATUSES.has(status)) throw error(400, 'invalid_filter', 'Geçersiz durum filtresi.');
  const from = dateFilter(query.from), to = dateFilter(query.to, true);
  if (from !== null && to !== null && from > to) throw error(400, 'invalid_filter', 'Başlangıç tarihi bitişten sonra olamaz.');
  if (query.format !== undefined && !['json', 'csv'].includes(query.format)) throw error(400, 'invalid_filter', 'Geçersiz dışa aktarma biçimi.');
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(query.cursor)) throw error(400, 'invalid_cursor', 'Geçersiz sayfa bilgisi.');
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || !requestId(cursor.id) || iso(cursor.t) !== cursor.t) throw new Error();
    } catch { throw error(400, 'invalid_cursor', 'Geçersiz sayfa bilgisi.'); }
  }
  return { limit, model, key, status, from, to, cursor, format: query.format || 'json' };
}
function queryHistory(state, userId, query = {}, now = Date.now()) {
  const selected = parseFilters(query);
  const user = Object.values(state.users || {}).find(candidate => candidate.id === userId && candidate.enabled === true);
  if (!user) throw error(401, 'unauthorized', 'Oturum geçersiz.');
  const saved = history(state);
  const own = Object.values(saved?.entries || {}).filter(row => row.user_id === userId
    && Date.parse(row.started_at) >= now - RETENTION_DAYS * 86400000)
    .map(row => publicRecord(row, now)).filter(Boolean)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))
    .slice(0, MAX_PER_ACCOUNT);
  const keys = new Map();
  const health = new Map();
  for (const row of own) {
    if (row.key_id && !keys.has(row.key_id)) keys.set(row.key_id, { id: row.key_id, name: row.key_name });
    if (!row.model) continue;
    if (!health.has(row.model)) health.set(row.model, { model: row.model, last_success_at: null, last_error_at: null, last_error_code: null, last_http_status: null });
    const model = health.get(row.model);
    if (row.status === 'success' && (!model.last_success_at || (row.completed_at || row.started_at) > model.last_success_at)) model.last_success_at = row.completed_at || row.started_at;
    if (['error', 'cancelled', 'unknown'].includes(row.status) && (!model.last_error_at || (row.completed_at || row.started_at) > model.last_error_at)) {
      model.last_error_at = row.completed_at || row.started_at; model.last_error_code = row.error_code; model.last_http_status = row.http_status;
    }
  }
  const matching = own.filter(row => (!selected.model || row.model === selected.model) && (!selected.key || row.key_id === selected.key)
    && (!selected.status || row.status === selected.status) && (selected.from === null || Date.parse(row.started_at) >= selected.from)
    && (selected.to === null || Date.parse(row.started_at) <= selected.to));
  const after = selected.cursor ? matching.filter(row => row.started_at < selected.cursor.t
    || (row.started_at === selected.cursor.t && row.id < selected.cursor.id)) : matching;
  const items = selected.format === 'csv' ? matching : after.slice(0, selected.limit);
  const last = items[items.length - 1];
  return { items, next_cursor: selected.format !== 'csv' && after.length > items.length && last
    ? Buffer.from(JSON.stringify({ t: last.started_at, id: last.id })).toString('base64url') : null,
    total: matching.length, retention: { days: RETENTION_DAYS, max_per_account: MAX_PER_ACCOUNT, max_total_records: MAX_RECORDS,
      tracking_started_at: iso(saved?.accounts[userId]?.started_at),
      notice: 'Bu hesaba ait kaydedilmiş üretim denemeleri. Son 30 gün, hesap başına en fazla 200 ve hizmet genelinde 2000 kayıt tutulur. Önceki istekler geriye dönük oluşturulmaz; mesaj ve yanıt içeriği kaydedilmez.' },
    filters: { models: [...new Set(own.map(row => row.model).filter(Boolean))].sort(), keys: [...keys.values()] },
    model_health: [...health.values()] };
}
const CSV_FIELDS = ['id', 'started_at', 'completed_at', 'model', 'key_name', 'key_id', 'endpoint', 'status', 'http_status', 'error_code', 'latency_ms', 'usage_status', 'input_tokens', 'output_tokens', 'total_tokens', 'response_id'];
function csvExport(items) {
  const cell = value => {
    let text = value === null || value === undefined ? '' : String(value);
    // Avoid spreadsheet formulas, including whitespace-prefixed formulas.
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\ufeff' + [CSV_FIELDS.join(','), ...items.map(row => CSV_FIELDS.map(field => cell(row[field])).join(','))].join('\r\n') + '\r\n';
}
function createHistoryStore(storage = require('./state-store'), { now = Date.now } = {}) {
  return { getActivity: async (userId, query) => queryHistory(await storage.readState(), userId, query, now()) };
}
module.exports = { RETENTION_DAYS, MAX_PER_ACCOUNT, MAX_RECORDS, startRequest, finishRequest, cleanupHistory,
  publicRecord, parseFilters, queryHistory, csvExport, createHistoryStore };

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRequest, finishRequest, queryHistory, cleanupHistory, csvExport, parseFilters, createHistoryStore } = require('../lib/request-history');
const { expireAccountingReservations } = require('../lib/usage-accounting');
const { createHandler } = require('../api/activity');
const now = Date.parse('2026-11-26T18:00:00.000Z');
const id = number => number.toString(16).padStart(32, '0');
const state = () => ({ users: { a: { id: 'user-a', enabled: true }, b: { id: 'user-b', enabled: true } }, keys: {}, usage: {}, reservations: {} });
function add(saved, number, fields = {}, outcome = {}) {
  startRequest(saved, { id: id(number), user_id: 'user-a', key_id: 'key_web', key_name: 'Web sitesi', model: 'gpt-6.1-sol',
    endpoint: 'v1/responses', started_at: new Date(now - number * 1000).toISOString(), ...fields });
  finishRequest(saved, id(number), { status: 'success', http_status: 200, input_tokens: 3, output_tokens: 2, latency_ms: 81,
    completed_at: new Date(now - number * 1000 + 100).toISOString(), response_id: 'resp_history_test', ...outcome });
}
function res() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } }; }
test('legacy accounts have an empty honest log without rewriting historical activity', () => {
  const saved = state(), before = structuredClone(saved);
  const result = queryHistory(saved, 'user-a', {}, now);
  assert.deepEqual(result.items, []); assert.equal(result.retention.tracking_started_at, null);
  assert.match(result.retention.notice, /geriye dönük oluşturulmaz/);
  assert.deepEqual(saved, before);
  assert.throws(() => queryHistory(saved, 'user-c', {}, now), { status: 401 });
  saved.users.a.enabled = false;
  assert.throws(() => queryHistory(saved, 'user-a', {}, now), { status: 401 });
});
test('start and finish whitelist metadata and never retain content, auth, user id in public data or private diagnostics', () => {
  const saved = state();
  startRequest(saved, { id: id(1), user_id: 'user-a', key_id: 'key_web', key_name: 'Web sitesi', model: 'gpt-6.1-sol', endpoint: 'v1/responses',
    started_at: new Date(now).toISOString(), input: 'private prompt', authorization: 'Bearer private-secret', ip: 'private-ip' });
  finishRequest(saved, id(1), { status: 'error', http_status: 502, error_code: 'upstream_generation_failed', error_message: 'private diagnostic',
    response: 'private response', input_tokens: 12, output_tokens: 5, total_tokens: 500, response_id: 'resp_test', completed_at: new Date(now + 23).toISOString(), latency_ms: 23 });
  const text = JSON.stringify(saved.activity);
  for (const value of ['private prompt', 'private-secret', 'private-ip', 'private diagnostic', 'private response']) assert.equal(text.includes(value), false);
  const result = queryHistory(saved, 'user-a', {}, now + 30);
  assert.equal(result.items[0].total_tokens, 17); assert.equal(result.items[0].status, 'error');
  assert.equal(result.items[0].usage_status, 'verified');
  assert.equal(JSON.stringify(result).includes('user-a'), false);
  const before = structuredClone(saved.activity);
  startRequest(saved, { ...saved.activity.entries[id(1)], input: 'another prompt' });
  finishRequest(saved, id(1), { status: 'unknown', error_code: 'unknown' });
  assert.deepEqual(saved.activity, before, 'retry and uncertainty cannot erase actual verified terminal');
});
test('unknown and not-started requests have null counts, and late verified zero usage is real zero', () => {
  const saved = state();
  add(saved, 1, {}, { status: 'unknown', usage_status: 'unavailable', input_tokens: undefined, output_tokens: undefined });
  assert.equal(queryHistory(saved, 'user-a', {}, now).items[0].total_tokens, null);
  finishRequest(saved, id(1), { status: 'success', input_tokens: 0, output_tokens: 0, completed_at: new Date(now).toISOString() });
  const row = queryHistory(saved, 'user-a', {}, now).items[0];
  assert.equal(row.total_tokens, 0); assert.equal(row.usage_status, 'verified');
  add(saved, 2, {}, { status: 'error', usage_status: 'not_started', http_status: 429, error_code: 'rate_limited', input_tokens: undefined, output_tokens: undefined });
  const rejected = queryHistory(saved, 'user-a', { status: 'error' }, now).items[0];
  assert.equal(rejected.total_tokens, null); assert.equal(rejected.usage_status, 'not_started');
});
test('own-account filters, stable pagination, and unfiltered model health work independently', () => {
  const saved = state();
  add(saved, 1); add(saved, 2, { key_id: 'key_codex', key_name: 'Codex' });
  add(saved, 3, { model: 'gpt-6-astra' }, { status: 'error', http_status: 503, error_code: 'upstream_http_error' });
  add(saved, 4, { user_id: 'user-b', model: 'private-other-model', key_name: 'Other private project' });
  const first = queryHistory(saved, 'user-a', { limit: '1' }, now);
  assert.equal(first.total, 3); assert.equal(first.items[0].id, id(1)); assert.ok(first.next_cursor);
  const second = queryHistory(saved, 'user-a', { limit: '1', cursor: first.next_cursor }, now);
  assert.equal(second.items[0].id, id(2));
  assert.equal(JSON.stringify(first).includes('private-other-model'), false);
  assert.equal(queryHistory(saved, 'user-a', { model: 'gpt-6-astra', status: 'error' }, now).total, 1);
  assert.equal(queryHistory(saved, 'user-a', { key_id: 'key_codex' }, now).items[0].id, id(2));
  const day = queryHistory(saved, 'user-a', { from: '2026-11-26', to: '2026-11-26' }, now);
  assert.equal(day.total, 3);
  assert.equal(queryHistory(saved, 'user-a', { to: '2026-11-25' }, now).total, 0);
  const filtered = queryHistory(saved, 'user-a', { model: 'gpt-6.1-sol', limit: '1' }, now);
  assert.equal(filtered.model_health.length, 2, 'model health includes all retained own records, not the selected page');
  assert.equal(filtered.model_health.find(row => row.model === 'gpt-6-astra').last_http_status, 503);
});
test('filters fail closed for arrays, invalid calendar dates, injection and malformed cursors', () => {
  for (const query of [{limit:'0'}, {limit:'101'}, {limit:['25']}, {status:['success']}, {status:'anything'}, {model:'secret prompt'},
    {key_id:'<script>'}, {cursor:'hello'}, {cursor:['x']}, {from:'2026-02-30'}, {from:'2026-11-27',to:'2026-11-26'}, {format:'html'}, {user_id:'user-b'}]) {
    assert.throws(() => parseFilters(query), { status: 400 }, JSON.stringify(query));
  }
});
test('expired holds update activity and per-key uncertainty once, including truthful read before cleanup', () => {
  const saved = state();
  const day = Math.floor(now / 86400000);
  saved.usage['user-a'] = { day, unknown_requests_today: 0 };
  saved.keys.digest = { id:'key_web',user_id:'user-a',usage:{day,unknown_requests_today:0} };
  startRequest(saved, { id:id(1),user_id:'user-a',key_id:'key_web',key_name:'Web',model:'gpt-6.1-sol',endpoint:'v1/responses',started_at:new Date(now-601000).toISOString() });
  saved.reservations[id(1)]={kind:'tokens',user_id:'user-a',key_id:'key_web',day,hold_expires_at:now/1000-1,expires_at:now/1000+100};
  assert.equal(queryHistory(saved,'user-a',{},now).items[0].status,'unknown');
  expireAccountingReservations(saved,now/1000); expireAccountingReservations(saved,now/1000);
  assert.equal(saved.usage['user-a'].unknown_requests_today,1); assert.equal(saved.keys.digest.usage.unknown_requests_today,1);
  const row=queryHistory(saved,'user-a',{},now).items[0];
  assert.equal(row.status,'unknown'); assert.equal(row.error_code,'request_timeout'); assert.equal(row.total_tokens,null);
  expireAccountingReservations(saved,now/1000+30);
  assert.equal(queryHistory(saved,'user-a',{},now+30000).items[0].completed_at,row.completed_at,'unrelated later mutations cannot move the recorded timeout');
  finishRequest(saved,id(1),{status:'error',usage_status:'unavailable',http_status:503,error_code:'upstream_http_error',completed_at:new Date(now).toISOString()});
  expireAccountingReservations(saved,now/1000+1);
  const knownError=queryHistory(saved,'user-a',{},now+1000).items[0];
  assert.equal(knownError.status,'error'); assert.equal(knownError.error_code,'upstream_http_error'); assert.equal(knownError.http_status,503);
});
test('retention bounds rows per account, globally, by date, and removes deleted account records', () => {
  const saved=state();
  startRequest(saved,{id:id(1),user_id:'user-a',model:'gpt-6.1-sol',endpoint:'v1/responses',started_at:new Date(now).toISOString()});
  const template=saved.activity.entries[id(1)];
  for(let u=0;u<12;u++) {
    saved.users['u'+u]={id:'user-'+u,enabled:true};
    for(let i=0;i<210;i++){const value=10000+u*1000+i; saved.activity.entries[id(value)]={...template,id:id(value),user_id:'user-'+u,started_at:new Date(now-i).toISOString()};}
  }
  saved.activity.entries[id(2)]={...template,id:id(2),user_id:'deleted-user'};
  saved.activity.entries[id(3)]={...template,id:id(3),started_at:new Date(now-31*86400000).toISOString()};
  cleanupHistory(saved,now/1000);
  const rows=Object.values(saved.activity.entries);
  assert.equal(rows.length,2000); assert.ok(rows.every(row=>row.user_id!=='deleted-user'&&row.id!==id(3)));
  for(const user of Object.values(saved.users)) assert.ok(rows.filter(row=>row.user_id===user.id).length<=200);
});
test('CSV exports every matching retained row and neutralizes formulas while preserving comma/quote values', () => {
  const saved=state(); for(let n=1;n<=30;n++) add(saved,n,{key_name:' =SUM(1,2) "project"'});
  const result=queryHistory(saved,'user-a',{limit:'1',format:'csv'},now);
  assert.equal(result.items.length,30); assert.equal(result.next_cursor,null);
  const csv=csvExport(result.items);
  assert.ok(csv.startsWith('\ufeffid,')); assert.match(csv,/'=SUM\(1,2\) ""project""/);
  assert.equal(csv.includes('user-a'),false); assert.equal(csv.split('\r\n').length,32);
});
test('activity endpoint requires session, rejects mutations and applies no-store to CSV and JSON',async()=>{
  const saved=state(); add(saved,1);
  const service=createHistoryStore({readState:async()=>structuredClone(saved)},{now:()=>now});
  const handler=createHandler(service,{requireUser:async()=>({id:'user-a'})});
  const response=res(); await handler({method:'GET',query:{}},response);
  assert.equal(response.statusCode,200); assert.equal(JSON.parse(response.body).items.length,1);
  assert.equal(response.headers['cache-control'],'private, no-store'); assert.equal(response.headers.vary,'Cookie, Origin');
  const csv=res(); await handler({method:'GET',query:{format:'csv'}},csv);
  assert.match(csv.headers['content-type'],/^text\/csv/); assert.match(csv.headers['content-disposition'],/attachment/);
  const rejected=res(); await handler({method:'POST'},rejected); assert.equal(rejected.statusCode,405);
  const missing=res(); await createHandler(service,{requireUser:async()=>{throw Object.assign(new Error('not signed in'),{status:401});}})({method:'GET',query:{}},missing);
  assert.equal(missing.statusCode,401); assert.equal(missing.body.includes('resp_'),false);
});

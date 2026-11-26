const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyStore } = require('../lib/key-store');
const { createHandler } = require('../api/proxy');
const { queryHistory } = require('../lib/request-history');
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
test.beforeEach(() => { process.env.XINGCHI_SOL_API_KEY = 'provider-secret'; });
test.afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });
function fixture() {
  const state = { users: { a: { id: 'user-a', username: 'Demo', enabled: true, requests_per_minute: 100 } },
    keys: {}, usage: {}, reservations: {}, sessions: {}, login_attempts: {} };
  let writes = 0;
  const storage = { isConfigured: () => true, readState: async () => structuredClone(state), mutateState: async operation => {
    writes++; const draft = structuredClone(state); const result = operation(draft); Object.assign(state, draft); return result;
  }};
  return { state, storage, store: createKeyStore(storage), writes: () => writes };
}
function request(apiKey, stream = false, path = 'v1/responses') {
  const input=path==='v1/responses'?{input:'PRIVATE prompt must never be logged'}:{messages:[{role:'user',content:'PRIVATE prompt must never be logged'}],max_tokens:128};
  return { method: 'POST', query: { path }, headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', ...input, stream })); } };
}
function sink() {
  return { headers: {}, chunks: [], statusCode: 200, setHeader(k,v) { this.headers[k]=v; },
    write(chunk) { this.chunks.push(String(chunk)); this.headersSent=true; return true; },
    end(chunk) { if(chunk) this.chunks.push(String(chunk)); this.writableEnded=true; } };
}
function provider(status = 'completed') {
  return { id: 'resp_integration', object: 'response', status, model: 'gpt-6.1-sol',
    output: [{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE response not logged',annotations:[]}]}],
    usage: { input_tokens:17,output_tokens:11,total_tokens:28 }, ...(status==='failed'?{error:{message:'PRIVATE provider diagnostic'}}:{}) };
}
test('real proxy/key-store records success and failed terminal metadata with two existing writes and no content', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    for (const stream of [false, true]) {
      const f=fixture(); const created=await f.store.createKey('user-a','Codex'); const before=f.writes();
      const terminal=provider(status);
      global.fetch=async()=>new Response(stream?`data: ${JSON.stringify({type:'response.'+status,response:terminal})}\n\n`:JSON.stringify(terminal),
        {headers:{'content-type':stream?'text/event-stream':'application/json'}});
      await createHandler(f.store)(request(created.api_key,stream),sink());
      assert.equal(f.writes()-before,2,'one reservation and one terminal settlement; history adds no roundtrip');
      const result=queryHistory(f.state,'user-a'); assert.equal(result.items.length,1);
      const row=result.items[0]; assert.equal(row.status,status==='completed'?'success':status==='cancelled'?'cancelled':'error');
      assert.equal(row.total_tokens,28); assert.equal(row.key_id,created.key.id); assert.equal(row.key_name,'Codex');
      assert.equal(row.response_id,'resp_integration'); assert.ok(Number.isSafeInteger(row.latency_ms));
      assert.equal(JSON.stringify(f.state.activity).includes('PRIVATE'),false);
      assert.equal(JSON.stringify(result).includes(created.api_key),false);
    }
  }
});
test('definite rejection, uncertain HTTP failure and connection failure are visible without inventing consumption',async()=>{
  for(const scenario of [403,503,'network']) {
    const f=fixture(),created=await f.store.createKey('user-a','Web sitesi'),before=f.writes();
    global.fetch=async()=>{if(scenario==='network') throw new Error('PRIVATE connection diagnostic'); return new Response('{"error":"PRIVATE provider message"}',{status:scenario,headers:{'content-type':'application/json'}});};
    const response=sink(); await createHandler(f.store)(request(created.api_key),response);
    const row=queryHistory(f.state,'user-a').items[0];
    assert.equal(f.writes()-before,2); assert.equal(row.status,'error'); assert.equal(row.total_tokens,null);
    assert.equal(row.usage_status,scenario===403?'not_started':'unavailable');
    assert.equal(row.http_status,scenario==='network'?502:scenario);
    assert.equal(JSON.stringify(f.state.activity).includes('PRIVATE'),false);
  }
});
test('valid-key admission denials are logged inside existing reservation write with no provider call',async()=>{
  const f=fixture(),created=await f.store.createKey('user-a','Test');
  f.state.users.a.requests_per_minute=1;
  const first=await f.store.reserve(created.api_key,{estimatedTokens:5,request:{model:'gpt-6.1-sol',endpoint:'v1/responses',started_at:new Date().toISOString()}});
  await f.store.release(first.reservation);
  const before=f.writes(); let calls=0;
  global.fetch=async()=>{calls++; throw new Error('Must not send rejected request upstream');};
  const response=sink(); await createHandler(f.store)(request(created.api_key),response);
  assert.equal(response.statusCode,429); assert.equal(calls,0); assert.equal(f.writes()-before,1);
  const rows=queryHistory(f.state,'user-a',{status:'error'}).items;
  assert.equal(rows.length,1); assert.equal(rows[0].error_code,'rate_limited'); assert.equal(rows[0].total_tokens,null);
  assert.equal(rows[0].latency_ms,null); assert.equal(rows[0].usage_status,'not_started');
});
test('known terminal rendering errors are recorded with verified use in the same settlement across adapters and transports',async()=>{
  for(const path of ['v1/chat/completions','v1/messages']) for(const stream of [false,true]) for(const sse of [false,true]) {
    for(const malformed of ['unsupported_incomplete_reason','invalid_message_content']) {
      const f=fixture(),created=await f.store.createKey('user-a','Render test'),before=f.writes();
      const terminal=provider();
      if(malformed==='unsupported_incomplete_reason'){terminal.status='incomplete';terminal.incomplete_details={reason:'unsupported_reason'};}
      else terminal.output[0].content=null;
      global.fetch=async()=>new Response(sse?`data: ${JSON.stringify({type:terminal.status==='incomplete'?'response.incomplete':'response.completed',response:terminal})}\n\n`:JSON.stringify(terminal),
        {headers:{'content-type':sse?'text/event-stream':'application/json'}});
      const response=sink(); await createHandler(f.store)(request(created.api_key,stream,path),response);
      assert.equal(response.statusCode,502,`${path}/${stream}/${sse}/${malformed}`);
      const row=queryHistory(f.state,'user-a').items[0];
      assert.equal(row.status,'error');assert.equal(row.http_status,502);assert.equal(row.total_tokens,28);
      assert.equal(row.usage_status,'verified');assert.equal(row.error_code,'invalid_upstream_response');
      assert.equal(f.writes()-before,2,'rendering validation adds no normal-path accounting write');
    }
  }
});
test('terminal status mismatches and inconsistent streamed prefixes retain actual use without false success',async()=>{
  for(const path of ['v1/responses','v1/chat/completions','v1/messages']) {
    const f=fixture(),created=await f.store.createKey('user-a','Status test'),terminal={...provider(),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}};
    global.fetch=async()=>new Response(`data: ${JSON.stringify({type:'response.completed',response:terminal})}\n\n`,{headers:{'content-type':'text/event-stream'}});
    const response=sink();await createHandler(f.store)(request(created.api_key,true,path),response);
    const row=queryHistory(f.state,'user-a').items[0];assert.equal(response.statusCode,502);assert.equal(row.status,'error');assert.equal(row.total_tokens,28);
  }
  for(const path of ['v1/chat/completions','v1/messages']) {
    const f=fixture(),created=await f.store.createKey('user-a','Stream test'),terminal=provider();
    const events=[{type:'response.output_text.delta',output_index:0,content_index:0,delta:'inconsistent prefix'}, {type:'response.completed',response:terminal}];
    global.fetch=async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    const response=sink();await createHandler(f.store)(request(created.api_key,true,path),response);
    const row=queryHistory(f.state,'user-a').items[0];assert.equal(row.status,'error');assert.equal(row.http_status,200,'SSE headers were already sent');assert.equal(row.total_tokens,28);
    assert.equal(row.error_code,'invalid_upstream_response');
  }
});

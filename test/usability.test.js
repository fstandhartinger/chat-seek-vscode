const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SummaryStore, resolveProviders, redact, sampleChat } = require('../src/summaries');
const { relativeTime, resumeSpec } = require('../src/presentation');
const { parseJsonl } = require('../src/indexer');
const records = [{ role:'user',text:'Build a JevBench score page.',time:'2026-09-10' },{ role:'assistant',text:'Implemented the scoring page and calibration tests.',time:'2026-09-11' }];
test('relative dates handle ISO, milliseconds, seconds, unknown and future',()=>{
 const now=Date.parse('2026-09-21T12:00:00Z');
 assert.equal(relativeTime('2026-09-14T12:00:00Z',now),'1 week ago');
 assert.equal(relativeTime((now-3600000)/1000,now),'1 hour ago');
 assert.equal(relativeTime(now-86400000,now),'1 day ago');
 assert.equal(relativeTime(null,now),'Date unknown');
 assert.equal(relativeTime(now+60000,now),'just now');
});
test('resume uses validated session IDs and argument arrays',()=>{
 const id='31036e59-c03a-4e19-980e-4088fd6510d7';
 assert.deepEqual(resumeSpec({source:'Claude Code',session:id}),{executable:'claude',args:['--resume',id]});
 assert.deepEqual(resumeSpec({source:'Codex',session:'2026-09-21T00-00-'+id}),{executable:'codex',args:['resume',id]});
 assert.equal(resumeSpec({source:'OpenCode',session:'ses_x; touch bad'}),null);
 assert.deepEqual(resumeSpec({source:'OpenCode',session:'ses_abc123'}).args,['--session','ses_abc123']);
});
test('provider discovery skips missing keys and supports OpenRouter alias',async()=>{
 const p=await resolveProviders({provider:'auto'},async()=>undefined,{OPEN_ROUTER_API_KEY:'test'});
 assert.deepEqual(p.map(x=>x.name),['openrouter']);
 await assert.rejects(resolveProviders({provider:'custom',customUrl:'http://remote.test/v1',customModel:'x'},async()=>'test',{}),/HTTPS/);
});
test('summary fallback, cache reuse and changed-chat invalidation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chat-seek-summary-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0;const store=new SummaryStore(path.join(dir,'cache.json'),async url=>{calls++;return url.includes('bad')?{ok:false,status:429}:{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'Built the JevBench scoring page with calibration tests.'}}]})};});
 const providers=[{label:'OpenAI',url:'https://bad.test/v1',key:'secret',model:'gpt-4.1-nano'},{label:'OpenRouter',url:'https://ok.test/v1',key:'secret',model:'openai/gpt-4.1-nano'}];
 const first=await store.get(records,providers);assert.equal(first.provider,'OpenRouter');assert.equal(calls,2);
 await store.get(records,providers);assert.equal(calls,2);
 const loaded=new SummaryStore(store.file);await loaded.load();assert.equal(loaded.cached(records).text,first.text);
 await store.get([...records,{role:'user',text:'Now add a chart.'}],providers);assert.equal(calls,4);
});
test('sampling stays bounded, covers end of chat, and redacts known credentials',()=>{
 const many=Array.from({length:100},(_,i)=>({role:'user',text:`Message ${i}: `+'x'.repeat(1000)}));
 const sample=sampleChat(many);assert.ok(sample.length<7500);assert.ok(sample.includes('Message 99'));
 assert.ok(!redact('api_key=secretvalue and sk-1234567890123456 known-test-secret',['known-test-secret']).includes('secretvalue'));
 assert.ok(!redact('known-test-secret',['known-test-secret']).includes('known-test-secret'));
});
test('Codex metadata preserves resume ID and working directory',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chat-seek-meta-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'rollout-old-name.jsonl');const id='31036e59-c03a-4e19-980e-4088fd6510d7';
 await fs.writeFile(file,[{type:'session_meta',payload:{id,cwd:'/tmp/project'}},{type:'response_item',timestamp:'2026-09-21',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Build a chart'}]}}].map(JSON.stringify).join('\n'));
 const r=await parseJsonl(file,'Codex');assert.equal(r[0].session,id);assert.equal(r[0].cwd,'/tmp/project');
});

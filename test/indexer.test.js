'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseClaude, parseCodex, parseJsonl, parseOpenCode, ChatIndex } = require('../src/indexer');
const { lexicalSearch, groupBySession, rerankWithLaya } = require('../src/search');

test('Claude and Codex parsers index chat text but ignore tool payloads', () => {
  assert.equal(parseClaude({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', input: { secret: 'hidden' } }, { type: 'text', text: 'Built the search.' }] } }).text, 'Built the search.');
  assert.equal(parseClaude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'secret' }] } }), null);
  assert.equal(parseCodex({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } }), null);
  assert.equal(parseCodex({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'Final answer' }] } }).text, 'Final answer');
});

test('index updates changed files and drops deleted files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-seek-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects'); fs.mkdirSync(root);
  const file = path.join(root, 'session.jsonl');
  const make = text => JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-09-21', message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(file, make('We built JevBench here.'));
  const index = new ChatIndex(path.join(dir, 'index.json'));
  assert.equal(await index.rebuild([{ source: 'Claude Code', path: root }]), 1);
  assert.equal(lexicalSearch(index.records, 'JevBench').length, 1);
  fs.writeFileSync(file, make('We built Laya here instead.'));
  assert.equal(await index.rebuild([{ source: 'Claude Code', path: root }]), 1);
  assert.equal(lexicalSearch(index.records, 'JevBench').length, 0);
  const loaded = new ChatIndex(index.cachePath); await loaded.load();
  assert.equal(lexicalSearch(loaded.records, 'Laya').length, 1);
  fs.unlinkSync(file);
  assert.equal(await loaded.rebuild([{ source: 'Claude Code', path: root }]), 0);
});

test('OpenCode joins session, message, and text part', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-seek-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const p of ['session/x', 'message/s1', 'part/m1']) fs.mkdirSync(path.join(dir, p), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session/x/s1.json'), JSON.stringify({ id: 's1', title: 'Build a router' }));
  fs.writeFileSync(path.join(dir, 'message/s1/m1.json'), JSON.stringify({ id: 'm1', role: 'user' }));
  fs.writeFileSync(path.join(dir, 'part/m1/p1.json'), JSON.stringify({ sessionID: 's1', messageID: 'm1', type: 'text', text: 'Use Laya to choose a model.' }));
  const records = await parseOpenCode(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Build a router');
  assert.equal(records[0].text, 'Use Laya to choose a model.');
});

test('local model score changes ranking of shortlisted messages', async () => {
  const records = [
    { source: 'Claude Code', session: 's1', text: 'JevBench mentioned in a random unrelated note.', title: 'Other', role: 'user', path: '/one', line: 1 },
    { source: 'Codex', session: 's2', text: 'We implemented the JevBench ranking and tests.', title: 'Implement benchmark', role: 'user', path: '/two', line: 1 }
  ];
  const shortlist = lexicalSearch(records, 'JevBench implementation');
  const model = { systemOne: async state => ({ answers: { match: { score: state.candidate.includes('implemented') ? 2.8 : 0.2 } } }) };
  const ranked = await rerankWithLaya(shortlist, 'JevBench implementation', model);
  assert.equal(groupBySession(ranked)[0].session, 's2');
});

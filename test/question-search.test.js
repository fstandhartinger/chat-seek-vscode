const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isQuestion, chatGroups, spoolChat, readChunk, closeSpool, reverseLines, reverseChatChunks, likelyOriginalChunks, parseExtraction, extractAnswer, scanQuestions, fullEntry } = require('../src/question-search');

const model = {
  config: { max_len: 512 },
  encode: text => [...text],
  systemOne: async excerpt => ({ answers: { answer: { noul: excerpt.includes('violet comet') ? 0.95 : 0.02 } } })
};
test('Laya checks intent and clear factual questions survive an uncertain judgment', async () => {
  const uncertain = { systemOne: async () => ({ answers: { question: { noul: 0.25 } } }) };
  assert.equal(await isQuestion(uncertain, "What's the product launch date?"), true);
  assert.equal(await isQuestion(uncertain, 'Where did we discuss the product launch?'), false);
  assert.equal(await isQuestion(uncertain, 'Find the chat about the product launch'), false);
});
test('question scan reads complete source, overlaps chunks, and visits newest chat/chunk first', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-question-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = path.join(dir, 'old.jsonl'), fresh = path.join(dir, 'fresh.jsonl');
  const claude = (text, time) => JSON.stringify({ type: 'assistant', timestamp: time, sessionId: 'test', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const hiddenAnswer = 'The answer is violet comet.';
  await fs.writeFile(old, claude('Older chat has no answer.', '2026-01-01'));
  await fs.writeFile(fresh, [claude('a'.repeat(3200) + hiddenAnswer + 'b'.repeat(1500), '2026-02-01'), claude('Latest note.', '2026-02-02')].join('\n'));
  const records = [
    { source: 'Claude Code', session: 'old', path: old, line: 1, role: 'assistant', text: 'Older chat has no answer.', time: '2026-01-01', title: 'Old' },
    { source: 'Claude Code', session: 'fresh', path: fresh, line: 1, role: 'assistant', text: 'a'.repeat(2800), time: '2026-02-01', title: 'Fresh' },
    { source: 'Claude Code', session: 'fresh', path: fresh, line: 2, role: 'assistant', text: 'Latest note.', time: '2026-02-02', title: 'Fresh' }
  ];
  const groups = chatGroups(records);
  assert.equal(groups[0].session, 'fresh');
  const spool = await spoolChat(groups[0], model, 300);
  try {
    const chunks = await Promise.all(spool.offsets.map(x => readChunk(spool, x)));
    assert.ok(chunks.length > 10);
    assert.ok(chunks.some(x => x.includes(hiddenAnswer)), 'answer beyond indexed 2,800 characters is retained');
    assert.ok(chunks.some((x, i) => i && chunks[i - 1].slice(-20) === x.slice(0, 20)), 'adjacent chunks overlap');
    assert.ok(chunks.every(x => model.encode(x).length <= 300));
  } finally { await closeSpool(spool); }
  const seen = [], results = [];
  await scanQuestions(groups, 'What was the answer?', model, [], new AbortController().signal, () => {}, async item => { seen.push(item.session); results.push(item); });
  assert.ok(results.length >= 1);
  assert.equal(seen[0], 'fresh');
  assert.ok(results.some(x => x.chunk.includes(hiddenAnswer)));
});
test('full transcript extraction includes Codex tool output and Claude tool results', () => {
  assert.equal(fullEntry({ type: 'response_item', payload: { type: 'function_call_output', output: 'The answer is 42.' } }, 'Codex').text, 'The answer is 42.');
  assert.equal(fullEntry({ type: 'user', message: { content: [{ type: 'tool_result', content: 'The answer is 42.' }] } }, 'Claude Code').text, 'The answer is 42.');
});
test('reverse reader starts with the newest line even across a large JSONL line', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-reverse-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'large.jsonl');
  const middle = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(300000) } });
  await fs.writeFile(file, ['old', middle, 'new'].join('\n'));
  const lines = [];
  for await (const raw of reverseLines(file)) lines.push(raw);
  assert.equal(lines[0], 'new');
  assert.equal(lines[1], middle);
  assert.equal(lines[2], 'old');
});
test('reverse chunk stream checks latest text first and covers long unindexed tails', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-reverse-chat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl');
  const entry = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: text } });
  await fs.writeFile(file, [entry('EARLIEST-MARKER ' + 'a'.repeat(4000) + ' DEEP-ANSWER'), entry('LATEST-MARKER')].join('\n'));
  const group = { source: 'Claude Code', session: 'demo', records: [{ path: file, line: 1, time: '2026-01-01' }, { path: file, line: 2, time: '2026-01-02' }] };
  const chunks = [];
  for await (const part of reverseChatChunks(group, model, 300)) chunks.push(part.text);
  assert.ok(chunks[0].includes('LATEST-MARKER'));
  assert.ok(chunks.some(x => x.includes('DEEP-ANSWER')));
  assert.ok(chunks.at(-1).includes('EARLIEST-MARKER'));
  assert.ok(chunks.every(x => model.encode(x).length <= 300));
});
test('quick pass uses original source around indexed matches', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-quick-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl');
  const full = 'violet product ' + 'x'.repeat(2850) + ' launched on 12 March.';
  await fs.writeFile(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: full } }));
  const records = [{ source: 'Claude Code', session: 'demo', path: file, line: 1, role: 'assistant', text: full.slice(0, 2800), time: '2026-02-02', title: 'Violet product' }];
  const groups = chatGroups(records), chunks = [];
  for await (const part of likelyOriginalChunks(records, groups, 'When was the violet product launched?', model, 300)) chunks.push(part.text);
  assert.ok(chunks.some(x => x.includes('launched on 12 March.')));
});
test('answer extraction validates exact citation and falls back after provider error', async () => {
  const providers = [{ label: 'OpenAI', url: 'https://first.test/v1', key: 'test1', model: 'gpt-5.6-luna' }, { label: 'OpenRouter', url: 'https://second.test/v1', key: 'test2', model: 'openai/gpt-5.6-luna' }];
  let calls = 0;
  const fetcher = async url => {
    calls++;
    if (url.includes('first')) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answerable: true, answer: 'The launch date was 12 March.', quote: 'launched on 12 March' }) } }] }) };
  };
  const answer = await extractAnswer('When did it launch?', 'It launched on 12 March after testing.', providers, undefined, fetcher);
  assert.equal(answer.citation, 'launched on 12 March');
  assert.equal(answer.provider, 'OpenRouter');
  assert.equal(calls, 2);
  assert.equal(parseExtraction('{"answerable":true,"answer":"12 March","quote":"not in excerpt"}', 'It launched on 12 March.'), null);
});
test('question scan keeps checking chunks while two answers are extracted and removes rejected candidates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-progressive-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const groups = [];
  for (let i = 0; i < 2; i++) {
    const file = path.join(dir, `${i}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `violet comet answer ${i}` } }));
    groups.push({ key: `Claude Code:${i}`, source: 'Claude Code', session: String(i), title: String(i), time: i, records: [{ path: file, line: 1, time: String(i) }] });
  }
  const waiting = [], shown = [], updates = [], removed = [];
  let reachedTwo;
  const twoShown = new Promise(resolve => { reachedTwo = resolve; });
  const scan = scanQuestions(groups, 'What was the answer?', model, [{ label: 'test' }], new AbortController().signal,
    () => {}, item => { const id = shown.length; shown.push(item); if (shown.length === 2) reachedTwo(); return id; },
    () => new Promise(resolve => waiting.push(resolve)),
    { onUpdate: (id, update) => updates.push({ id, update }), onRemove: id => removed.push(id) });
  await twoShown;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.length, 2, 'two extraction calls run while scanning continues');
  assert.equal(updates.length, 0, 'early chunks are visibly provisional');
  waiting[1]({ answer: 'Answer 1', citation: 'answer 1', provider: 'test' });
  waiting[0](null);
  const result = await scan;
  assert.equal(result.chats, 2);
  assert.equal(result.found, 1);
  assert.deepEqual(updates.map(x => x.id), [1]);
  assert.equal(updates[0].update.verification, 'verified');
  assert.deepEqual(removed, [0]);
});
test('stopping a question scan removes provisional answers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-seek-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'violet comet' } }));
  const group = { key: 'Claude Code:test', source: 'Claude Code', session: 'test', records: [{ path: file, line: 1, time: '2026-01-01' }] };
  const controller = new AbortController(), removed = [];
  let extractionStarted;
  const started = new Promise(resolve => { extractionStarted = resolve; });
  const scan = scanQuestions([group], 'What was the answer?', model, [{ label: 'test' }], controller.signal,
    () => {}, () => 'candidate', (_, __, ___, signal) => new Promise((resolve, reject) => {
      extractionStarted();
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    }), { onRemove: id => removed.push(id) });
  await started;
  controller.abort();
  const result = await scan;
  assert.equal(result.found, 0);
  assert.deepEqual(removed, ['candidate']);
});

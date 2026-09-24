const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isQuestion, chatGroups, spoolChat, readChunk, closeSpool, parseExtraction, extractAnswer, scanQuestions, fullEntry } = require('../src/question-search');

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

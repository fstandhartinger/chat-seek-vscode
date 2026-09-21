'use strict';
const STOP = new Set('a an and are as at be by can did do for from had has have how i in is it me my of on or our the their there this to was we what when where which who why with you your chat chats conversation conversations find search show about that one'.split(' '));
function terms(value) {
  return [...new Set((value.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_-]{2,}/gu) || []).filter(x => !STOP.has(x)))];
}
function lexicalSearch(records, query, limit = 80) {
  const q = terms(query);
  if (!q.length) return [];
  const scored = [];
  for (const record of records) {
    const hay = record.text.toLowerCase();
    let score = 0, found = 0;
    for (const word of q) {
      const pos = hay.indexOf(word);
      if (pos >= 0) { found++; score += 1 + (word.length > 5 ? 0.35 : 0) + (pos < 250 ? 0.4 : 0); }
    }
    if (!found) continue;
    score += (found / q.length) ** 2 * 5;
    if (hay.includes(query.toLowerCase())) score += 5;
    scored.push({ record, lexical: score, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
function focusExcerpt(value, query, max = 1000) {
  if (value.length <= max) return value;
  const words = terms(query);
  const lower = value.toLowerCase();
  const positions = words.map(word => lower.indexOf(word)).filter(pos => pos >= 0);
  if (!positions.length) return value.slice(0, max) + '…';
  let best = positions[0], bestCount = -1;
  for (const pos of positions) {
    const count = positions.filter(other => Math.abs(other - pos) < max / 2).length;
    if (count > bestCount) { best = pos; bestCount = count; }
  }
  const start = Math.max(0, Math.min(value.length - max, best - Math.floor(max / 3)));
  return (start ? '…' : '') + value.slice(start, start + max) + (start + max < value.length ? '…' : '');
}
function groupBySession(items, limit = 30, query = '') {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.record.source}:${item.record.session}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, source: item.record.source, title: item.record.title || item.record.text.slice(0, 90), path: item.record.path, session: item.record.session, time: item.record.time, score: item.score, matches: [] };
      groups.set(key, group);
    }
    group.score = Math.max(group.score, item.score);
    if (group.matches.length < 3) group.matches.push({ text: focusExcerpt(item.record.text, query, 1000), role: item.record.role, line: item.record.line, score: item.score });
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
async function rerankWithLaya(items, query, model, max = 12) {
  const output = items.map(x => ({ ...x }));
  const chosen = [];
  const seen = new Map();
  for (const item of output) {
    const key = `${item.record.source}:${item.record.session}`;
    if ((seen.get(key) || 0) >= 2) continue;
    chosen.push(item); seen.set(key, (seen.get(key) || 0) + 1);
    if (chosen.length >= max) break;
  }
  for (const item of chosen) {
    const result = await model.systemOne(
      { search: query.slice(0, 500), candidate: focusExcerpt(item.record.text, query, 900) },
      { match: { type: 'score', instructions: 'How well does candidate match the remembered chat described in search?', criteria: ['Unrelated to the search description', 'Only a passing mention of the topic', 'Discusses the same project or task', 'Direct evidence this is the conversation being sought'] } }
    );
    const semantic = result?.answers?.match?.score;
    if (typeof semantic === 'number' && Number.isFinite(semantic)) {
      item.semantic = semantic;
      item.score = semantic * 6 + Math.min(item.lexical, 10) * 0.25;
    }
  }
  output.sort((a, b) => b.score - a.score);
  return output;
}
module.exports = { terms, lexicalSearch, focusExcerpt, groupBySession, rerankWithLaya };

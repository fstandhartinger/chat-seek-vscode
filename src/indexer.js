'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
function homeRoots(home = os.homedir()) {
  return [
    { source: 'Claude Code', path: path.join(home, '.claude', 'projects') },
    { source: 'Claude Code', path: path.join(home, '.claude', 'archived_projects') },
    { source: 'Codex', path: path.join(home, '.codex', 'sessions') },
    { source: 'Codex', path: path.join(home, '.codex', 'archived_sessions') },
    { source: 'OpenCode', path: path.join(home, '.local', 'share', 'opencode', 'storage') }
  ];
}
async function* walk(root) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}
function plainContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x && ['text', 'input_text', 'output_text'].includes(x.type) && typeof x.text === 'string').map(x => x.text).join('\n');
}
function trimText(s) { return typeof s === 'string' ? s.replace(/\u0000/g, '').trim().slice(0, 2800) : ''; }
function parseClaude(d) {
  if (!['user', 'assistant'].includes(d.type)) return null;
  const role = d.message?.role || d.type;
  if (!['user', 'assistant'].includes(role)) return null;
  const text = trimText(plainContent(d.message?.content));
  return text ? { role, text, time: d.timestamp || null, session: d.sessionId || null } : null;
}
function parseCodex(d) {
  if (d.type !== 'response_item') return null;
  const p = d.payload;
  if (!p || p.type !== 'message' || !['user', 'assistant'].includes(p.role)) return null;
  if (p.role === 'assistant' && p.channel && p.channel !== 'final') return null;
  let text = plainContent(p.content);
  if (p.role === 'user' && text.includes('</environment_context>')) text = text.slice(text.lastIndexOf('</environment_context>') + '</environment_context>'.length);
  text = trimText(text);
  return text ? { role: p.role, text, time: d.timestamp || null } : null;
}
async function parseJsonl(file, source) {
  const result = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 128 * 1024 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0, title = '', session = path.basename(file, '.jsonl').replace(/^rollout-/, '');
  try {
    for await (const raw of lines) {
      line++;
      if (source === 'Codex' && !raw.includes('"type":"response_item"') && !raw.includes('"type": "response_item"')) continue;
      if (source === 'Claude Code' && !raw.includes('"type":"user"') && !raw.includes('"type":"assistant"')) continue;
      let d;
      try { d = JSON.parse(raw); } catch { continue; }
      const message = source === 'Claude Code' ? parseClaude(d) : parseCodex(d);
      if (!message) continue;
      if (message.session) session = message.session;
      if (!title && message.role === 'user') title = message.text.replace(/\s+/g, ' ').slice(0, 100);
      result.push({ source, path: file, session, line, role: message.role, text: message.text, title, time: message.time });
      if (result.length % 500 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  } finally { lines.close(); stream.destroy(); }
  for (const r of result) r.title = title;
  return result;
}
async function parseOpenCode(storage) {
  const sessions = new Map();
  for await (const file of walk(path.join(storage, 'session'))) {
    if (!file.endsWith('.json')) continue;
    try { const d = JSON.parse(await fsp.readFile(file, 'utf8')); sessions.set(d.id, d); } catch { /* malformed */ }
  }
  const messages = new Map();
  for await (const file of walk(path.join(storage, 'message'))) {
    if (!file.endsWith('.json')) continue;
    try { const d = JSON.parse(await fsp.readFile(file, 'utf8')); messages.set(d.id, { ...d, path: file }); } catch { /* malformed */ }
  }
  const records = [];
  for await (const file of walk(path.join(storage, 'part'))) {
    if (!file.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { continue; }
    if (d.type !== 'text' || typeof d.text !== 'string') continue;
    const m = messages.get(d.messageID);
    if (!m || !['user', 'assistant'].includes(m.role)) continue;
    const s = sessions.get(d.sessionID);
    const text = trimText(d.text);
    if (!text) continue;
    records.push({ source: 'OpenCode', path: file, session: d.sessionID, line: 1, role: m.role, text, title: s?.title || '', time: s?.time?.updated || m.time?.created || null });
  }
  return records;
}
class ChatIndex {
  constructor(cachePath) { this.cachePath = cachePath; this.records = []; this.manifest = {}; }
  async load() {
    try { const d = JSON.parse(await fsp.readFile(this.cachePath, 'utf8')); this.records = d.records || []; this.manifest = d.manifest || {}; } catch { /* first run */ }
  }
  async rebuild(roots, onProgress = () => {}) {
    const next = [], manifest = {};
    const existing = new Map();
    for (const r of this.records) {
      if (!existing.has(r.path)) existing.set(r.path, []);
      existing.get(r.path).push(r);
    }
    for (const root of roots) {
      if (root.source === 'OpenCode') {
        onProgress('Reading OpenCode');
        next.push(...await parseOpenCode(root.path));
        continue;
      }
      for await (const file of walk(root.path)) {
        if (!file.endsWith('.jsonl') || file.includes(`${path.sep}subagents${path.sep}`)) continue;
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        const stamp = `${st.size}:${st.mtimeMs}`;
        manifest[file] = stamp;
        if (this.manifest[file] === stamp && existing.has(file)) next.push(...existing.get(file));
        else { onProgress(`Reading ${root.source}: ${path.basename(file)}`); next.push(...await parseJsonl(file, root.source)); }
      }
    }
    this.records = next;
    this.manifest = manifest;
    await fsp.mkdir(path.dirname(this.cachePath), { recursive: true });
    const temp = `${this.cachePath}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ records: next, manifest }), { mode: 0o600 });
    await fsp.rename(temp, this.cachePath);
    return next.length;
  }
}
module.exports = { homeRoots, parseClaude, parseCodex, parseJsonl, parseOpenCode, ChatIndex };

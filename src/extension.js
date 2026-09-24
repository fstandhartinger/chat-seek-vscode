'use strict';
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatIndex, homeRoots } = require('./indexer');
const { lexicalSearch, groupBySession, rerankWithLaya } = require('./search');
const { SummaryStore, PROVIDERS, resolveProviders } = require('./summaries');
const { relativeTime, timestamp, resumeSpec } = require('./presentation');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { html } = require('./webview');
const { isQuestion, chatGroups, scanQuestions } = require('./question-search');

const webviews = new Set();
let summaryStore, summaryInit, summaryAbort, sessions = new Map(), currentItems = [];
let panel, index, indexInitPromise, rebuildPromise, modelPromise, latestQuery = 0;
let questionAbort, questionItems = new Map();
function roots() {
  const extra = vscode.workspace.getConfiguration('chatSeek').get('extraRoots', []);
  return [...homeRoots(), ...extra.map(p => ({ source: /opencode/i.test(p) ? 'OpenCode' : /codex/i.test(p) ? 'Codex' : 'Claude Code', path: p.replace(/^~/, require('node:os').homedir()) }))];
}
function post(message) { for (const view of webviews) view.postMessage(message); }
async function ensureIndex(context, force = false) {
  if (!indexInitPromise) {
    index = new ChatIndex(path.join(context.globalStorageUri.fsPath, 'index.json'));
    indexInitPromise = index.load();
  }
  await indexInitPromise;
  if (force || !index.records.length) {
    if (!rebuildPromise) {
      rebuildPromise = index.rebuild(roots(), text => post({ type: 'status', text }))
        .finally(() => { rebuildPromise = null; });
    }
    const count = await rebuildPromise;
    post({ type: 'status', text: `Indexed ${count.toLocaleString()} messages from Claude Code, Codex, and OpenCode.` });
  } else if (rebuildPromise) {
    await rebuildPromise;
  } else {
    post({ type: 'status', text: `Ready: ${index.records.length.toLocaleString()} local messages.` });
  }
  sessions = new Map();
  for (const record of index.records) {
    const key = `${record.source}:${record.session}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(record);
  }
  return index;
}
async function getModel() {
  if (!modelPromise) modelPromise = import('@receptron/laya').then(({ Laya }) => Laya.load({ executionProviders: ['cpu'], sessionOptions: { intraOpNumThreads: 4 } })).catch(err => { modelPromise = null; throw err; });
  return modelPromise;
}
async function search(context, query) {
  const turn = ++latestQuery;
  summaryAbort?.abort();
  questionAbort?.abort();
  summaryAbort = new AbortController();
  questionAbort = new AbortController();
  try {
    if (vscode.workspace.getConfiguration('chatSeek').get('useLaya', true)) {
      try {
        post({ type: 'status', text: 'Checking whether this is a question with local Laya…' });
        const model = await getModel();
        if (turn !== latestQuery) return;
        if (await isQuestion(model, query)) {
          if (turn !== latestQuery) return;
          await searchQuestion(context, query, model, turn, questionAbort.signal);
          return;
        }
      } catch (err) { post({ type: 'status', text: `Laya question check unavailable: ${String(err.message || err).slice(0, 130)}. Using chat search.` }); }
    }
    post({ type: 'mode', mode: 'chat' });
    const ix = await ensureIndex(context);
    if (turn !== latestQuery) return;
    const candidates = lexicalSearch(ix.records, query);
    await publishResults(context, groupBySession(candidates, 30, query));
    const summaries = summarizeResults(context, turn, summaryAbort.signal);
    void summaries;
    if (!candidates.length || !vscode.workspace.getConfiguration('chatSeek').get('useLaya', true)) { post({ type: 'status', text: `${candidates.length} matching messages · keyword ranking` }); return; }
    post({ type: 'status', text: 'Ranking likely chats with local Laya… first use downloads the model.' });
    try {
      const model = await getModel();
      if (turn !== latestQuery) return;
      const max = vscode.workspace.getConfiguration('chatSeek').get('maxRerank', 12);
      const ranked = await rerankWithLaya(candidates, query, model, max);
      if (turn !== latestQuery) return;
      await publishResults(context, groupBySession(ranked, 30, query));
      post({ type: 'status', text: `${candidates.length} matching messages · top ${Math.min(max, candidates.length)} reranked locally with Laya` });
    } catch (err) { post({ type: 'status', text: `Keyword results shown. Laya unavailable: ${String(err.message || err).slice(0, 180)}` }); }
  } catch (err) { post({ type: 'status', text: `Indexing failed: ${String(err.message || err).slice(0, 220)}` }); }
  finally { if (turn === latestQuery) post({ type: 'searchDone' }); }
}
async function searchQuestion(context, query, model, turn, signal) {
  const ix = await ensureIndex(context, true);
  if (turn !== latestQuery || signal.aborted) return;
  const groups = chatGroups(ix.records);
  questionItems.clear(); currentItems = [];
  post({ type: 'results', items: [] });
  post({ type: 'mode', mode: 'question' });
  let providers = [];
  try {
    const available = await resolveProviders(summaryConfig(), name => context.secrets.get(`summary.${name}`));
    if (available.length && !vscode.workspace.getConfiguration('chatSeek.answers').get('enabled', false)) {
      const consent = await vscode.window.showInformationMessage(`Extract answers with ${available.map(p => p.label).join(' → ')}? Matching original chat chunks will be sent to these providers and may incur charges. Chat Seek will verify that each citation appears exactly in the chunk.`, { modal: true }, 'Enable answers');
      if (consent === 'Enable answers') await vscode.workspace.getConfiguration('chatSeek.answers').update('enabled', true, vscode.ConfigurationTarget.Global);
    }
    if (vscode.workspace.getConfiguration('chatSeek.answers').get('enabled', false)) providers = available;
  } catch (err) { post({ type: 'summaryStatus', text: `Answer provider unavailable: ${err.message}` }); }
  if (turn !== latestQuery || signal.aborted) return;
  post({ type: 'summaryStatus', text: providers.length ? `Answer extraction: ${providers.map(p => p.label).join(' → ')}. Exact citations are checked against original text.` : 'No answer extraction enabled. Relevant full chunks will still appear; configure an API key and enable answers for extracted answers.' });
  post({ type: 'status', text: `Checking likely original messages first, then scanning all ${groups.length.toLocaleString()} chats.` });
  try {
    await scanQuestions(groups, query, model, providers, signal,
      p => {
        if (turn !== latestQuery) return;
        if (p.error) post({ type: 'summaryStatus', text: p.error });
        const text = p.phase === 'quick' && !p.done
          ? `Checking likely original messages · ${p.quickChunks.toLocaleString()} chunks · ${p.found.toLocaleString()} results${p.reading ? ` · ${p.reading}` : ''}${p.extracting ? ' · extracting answer…' : ''}`
          : `${p.done ? 'Finished' : signal.aborted ? 'Stopped' : 'Scanning full archive'} · ${p.chats.toLocaleString()}/${p.totalChats.toLocaleString()} chats complete · ${p.chunks.toLocaleString()} full-scan chunks · ${p.found.toLocaleString()} results${p.preparing ? ` · reading ${String(p.preparing).slice(0, 50)}` : ''}${p.extracting ? ' · extracting answer…' : ''}`;
        post({ type: 'status', text });
      },
      async item => {
        if (turn !== latestQuery || signal.aborted) return;
        const id = `${turn}-${questionItems.size}`;
        const full = { ...item, id, relativeDate: relativeTime(item.time), fullDate: Number.isFinite(item.time) ? new Date(item.time).toLocaleString() : '', canResume: !!resumeSpec(item) };
        questionItems.set(id, full);
        currentItems.push(full);
        post({ type: 'questionResult', item: full });
      }, undefined, { records: ix.records });
  } catch (err) { if (turn === latestQuery && !signal.aborted) post({ type: 'status', text: `Question scan stopped: ${String(err.message || err).slice(0, 220)}` }); }
}
function openConversation(key, line) {
  const [source, ...rest] = key.split(':');
  const session = rest.join(':');
  const matches = index?.records.filter(r => r.source === source && r.session === session) || [];
  const at = matches.findIndex(r => r.line === line);
  const start = Math.max(0, at - 5), end = Math.min(matches.length, at + 8);
  const body = matches.slice(start, end).map(r => `${r.role.toUpperCase()} · ${r.time || ''}\n${r.text}\n`).join('\n────────────────────────────────────────\n\n');
  const sourcePath = matches[0]?.path || '';
  return `Chat Seek · ${source}\nOriginal transcript: ${sourcePath}\nSession: ${session}\nShowing nearby indexed messages; long messages are clipped to 2,800 characters.\n\n${body}`;
}
function openChunk(id) {
  const item = questionItems.get(id);
  if (!item) return 'This chunk is no longer available. Run the search again.';
  return `Chat Seek · original transcript chunk\nSource: ${item.source}\nSession: ${item.session}\nQuestion result: ${item.answer || 'Potential answer in this chunk'}\nCitation: ${item.citation || 'No extracted citation'}\n\n${item.chunk}`;
}
function summaryConfig() {
  const config = vscode.workspace.getConfiguration('chatSeek.summaries');
  const values = { provider: config.get('provider', 'auto') };
  for (const name of Object.keys(PROVIDERS)) {
    values[`${name}Model`] = config.get(`${name}Model`);
    values[`${name}Url`] = config.get(`${name}Url`);
  }
  return values;
}
async function getSummaries(context) {
  if (!summaryInit) {
    summaryStore = new SummaryStore(path.join(context.globalStorageUri.fsPath, 'summaries.json'));
    summaryInit = summaryStore.load();
  }
  await summaryInit; return summaryStore;
}
async function publishResults(context, items) {
  const store = await getSummaries(context);
  currentItems = items.map(item => {
    const records = sessions.get(item.key) || [];
    const dates = records.map(r => timestamp(r.time)).filter(Number.isFinite);
    const time = dates.length ? dates.reduce((a, b) => Math.max(a, b)) : NaN;
    const summary = vscode.workspace.getConfiguration('chatSeek.summaries').get('enabled', false) ? store.cached(records) : null;
    return { ...item, time, relativeDate: relativeTime(time), fullDate: Number.isFinite(time) ? new Date(time).toLocaleString() : '', summary, canResume: !!resumeSpec(item) };
  });
  post({ type: 'results', items: currentItems });
}
async function summarizeResults(context, turn, signal) {
  if (!vscode.workspace.getConfiguration('chatSeek.summaries').get('enabled', false)) return;
  try {
    const providers = await resolveProviders(summaryConfig(), name => context.secrets.get(`summary.${name}`));
    if (!providers.length) { post({ type: 'summaryStatus', text: 'Add an API key using “Configure summaries” to enable descriptions.' }); return; }
    const store = await getSummaries(context), queue = [...currentItems];
    post({ type: 'summaryStatus', text: 'Creating cached chat descriptions…' });
    async function worker() {
      while (queue.length && turn === latestQuery && !signal.aborted) {
        const item = queue.shift();
        try {
          const summary = await store.get(sessions.get(item.key) || [], providers, signal);
          if (turn === latestQuery && !signal.aborted) post({ type: 'summary', key: item.key, summary });
        } catch (err) { if (!signal.aborted) post({ type: 'summaryStatus', text: `Descriptions unavailable: ${err.message}` }); return false; }
      }
      return true;
    }
    const success = await Promise.all([worker(), worker()]);
    if (turn === latestQuery && !signal.aborted && success.every(Boolean)) post({ type: 'summaryStatus', text: 'AI descriptions use sampled excerpts · cached locally.' });
  } catch (err) { if (turn === latestQuery) post({ type: 'summaryStatus', text: err.message }); }
}
async function configureSummaries(context) {
  const options = [{ label: 'Enable summaries', value: 'enable' }, { label: 'Add or replace an API key', value: 'key' }, { label: 'Disable summaries', value: 'disable' }, { label: 'Provider and model settings', value: 'settings' }];
  const action = await vscode.window.showQuickPick(options, { title: 'Chat Seek summaries' });
  if (!action) return;
  const config = vscode.workspace.getConfiguration('chatSeek.summaries');
  if (action.value === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'chatSeek.summaries');
  if (action.value === 'disable') { summaryAbort?.abort(); await config.update('enabled', false, vscode.ConfigurationTarget.Global); for (const item of currentItems) item.summary = null; post({ type: 'results', items: currentItems }); post({ type: 'summaryStatus', text: 'Summaries disabled. Search and Laya ranking stay local.' }); return; }
  if (action.value === 'key') {
    const provider = await vscode.window.showQuickPick(Object.entries(PROVIDERS).map(([value, spec]) => ({ label: spec.label, value })), { title: 'Store a summary API key securely in VS Code' });
    if (!provider) return;
    const key = await vscode.window.showInputBox({ title: `${provider.label} API key`, password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code SecretStorage. Leave empty to remove the stored key (environment keys may still apply).' });
    if (key === undefined) return;
    if (key.trim()) await context.secrets.store(`summary.${provider.value}`, key.trim()); else await context.secrets.delete(`summary.${provider.value}`);
  }
  const providers = await resolveProviders(summaryConfig(), name => context.secrets.get(`summary.${name}`));
  if (!providers.length) { vscode.window.showInformationMessage('No usable key configured. Add a key, or set custom endpoint and model settings.'); return; }
  const consent = await vscode.window.showInformationMessage(`Enable AI descriptions? Sampled chat excerpts will be sent to ${providers.map(p => p.label).join(' → ')} (fallback order) and may incur API charges. Common secrets are redacted, but other private text may remain.`, { modal: true }, 'Enable');
  if (consent !== 'Enable') return;
  await config.update('enabled', true, vscode.ConfigurationTarget.Global);
  summaryAbort?.abort(); summaryAbort = new AbortController();
  void summarizeResults(context, latestQuery, summaryAbort.signal);
}
async function resumeChat(key) {
  const records = sessions.get(key), record = records?.[0];
  if (!record) return;
  const spec = resumeSpec(record); if (!spec) return;
  try {
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'where.exe' : 'which', [spec.executable], { timeout: 5000 });
    const executable = stdout.trim().split(/\r?\n/)[0];
    if (!executable) throw new Error('missing');
    const cwd = record.cwd && fs.existsSync(record.cwd) ? record.cwd : undefined;
    const terminal = vscode.window.createTerminal({ name: `Chat Seek · ${record.source}`, shellPath: executable, shellArgs: spec.args, cwd });
    terminal.show();
  } catch { vscode.window.showInformationMessage(`${record.source} CLI was not found on PATH. Install it in this VS Code environment, or use “Read excerpt”.`); }
}
function wireView(context, webview) {
  webviews.add(webview); webview.html = html(crypto.randomBytes(16).toString('hex'));
  return webview.onDidReceiveMessage(async m => {
    try {
      if (m.type === 'ready') { await ensureIndex(context, true); if (currentItems.length) await publishResults(context, currentItems); }
      if (m.type === 'search' && typeof m.query === 'string') await search(context, m.query.slice(0, 500));
      if (m.type === 'stop') { questionAbort?.abort(); post({ type: 'status', text: 'Question scan stopped.' }); }
      if (m.type === 'configure') await configureSummaries(context);
      if (m.type === 'refresh') await ensureIndex(context, true);
      if (m.type === 'pin') { await vscode.commands.executeCommand('chatSeek.search'); await vscode.commands.executeCommand('workbench.action.pinEditor'); }
      if (m.type === 'resume' && typeof m.key === 'string') await resumeChat(m.key);
      if (m.type === 'openChunk' && typeof m.id === 'string' && questionItems.has(m.id)) {
        const uri = vscode.Uri.from({ scheme: 'chat-seek', path: '/chunk', query: m.id });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
      if (m.type === 'open' && typeof m.key === 'string' && sessions.has(m.key)) {
        const uri = vscode.Uri.from({ scheme: 'chat-seek', path: '/conversation', query: m.key, fragment: String(m.line) });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    } catch (err) { post({ type: 'status', text: `Chat Seek: ${err.message}` }); }
  });
}
function activate(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('chat-seek', { provideTextDocumentContent(uri) { return uri.path === '/chunk' ? openChunk(uri.query) : openConversation(uri.query, Number(uri.fragment)); } }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('chatSeek.sidebar', {
    resolveWebviewView(view) { view.webview.options = { enableScripts: true }; context.subscriptions.push(wireView(context, view.webview)); view.onDidDispose(() => webviews.delete(view.webview)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chatSeek.search', () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('chatSeek', 'Chat Seek', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    const webview = panel.webview;
    context.subscriptions.push(wireView(context, webview));
    panel.onDidDispose(() => { webviews.delete(webview); panel = undefined; });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chatSeek.configureSummaries', () => configureSummaries(context)));
  context.subscriptions.push(vscode.commands.registerCommand('chatSeek.rebuildIndex', async () => { await ensureIndex(context, true); vscode.window.showInformationMessage(`Chat Seek indexed ${index.records.length.toLocaleString()} messages.`); }));
}
async function deactivate() { summaryAbort?.abort(); questionAbort?.abort(); if (modelPromise) try { await (await modelPromise).close(); } catch { /* shutdown */ } }
module.exports = { activate, deactivate, openConversation };

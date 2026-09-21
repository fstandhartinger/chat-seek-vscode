'use strict';
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatIndex, homeRoots } = require('./indexer');
const { lexicalSearch, groupBySession, rerankWithLaya } = require('./search');
const { html } = require('./webview');

let panel, index, indexInitPromise, rebuildPromise, modelPromise, latestQuery = 0;
function roots() {
  const extra = vscode.workspace.getConfiguration('chatSeek').get('extraRoots', []);
  return [...homeRoots(), ...extra.map(p => ({ source: /opencode/i.test(p) ? 'OpenCode' : /codex/i.test(p) ? 'Codex' : 'Claude Code', path: p.replace(/^~/, require('node:os').homedir()) }))];
}
function post(message) { if (panel) panel.webview.postMessage(message); }
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
  return index;
}
async function getModel() {
  if (!modelPromise) modelPromise = import('@receptron/laya').then(({ Laya }) => Laya.load({ executionProviders: ['cpu'], sessionOptions: { intraOpNumThreads: 2 } })).catch(err => { modelPromise = null; throw err; });
  return modelPromise;
}
async function search(context, query) {
  const turn = ++latestQuery;
  try {
    const ix = await ensureIndex(context);
    if (turn !== latestQuery) return;
    const candidates = lexicalSearch(ix.records, query);
    post({ type: 'results', items: groupBySession(candidates, 30, query) });
    if (!candidates.length || !vscode.workspace.getConfiguration('chatSeek').get('useLaya', true)) { post({ type: 'status', text: `${candidates.length} matching messages · keyword ranking` }); return; }
    post({ type: 'status', text: 'Ranking likely chats with local Laya… first use downloads the model.' });
    try {
      const model = await getModel();
      if (turn !== latestQuery) return;
      const max = vscode.workspace.getConfiguration('chatSeek').get('maxRerank', 12);
      const ranked = await rerankWithLaya(candidates, query, model, max);
      if (turn !== latestQuery) return;
      post({ type: 'results', items: groupBySession(ranked, 30, query) });
      post({ type: 'status', text: `${candidates.length} matching messages · top ${Math.min(max, candidates.length)} reranked locally with Laya` });
    } catch (err) { post({ type: 'status', text: `Keyword results shown. Laya unavailable: ${String(err.message || err).slice(0, 180)}` }); }
  } catch (err) { post({ type: 'status', text: `Indexing failed: ${String(err.message || err).slice(0, 220)}` }); }
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
function activate(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('chat-seek', {
    provideTextDocumentContent(uri) { return openConversation(uri.query, Number(uri.fragment)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chatSeek.search', async () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('chatSeek', 'Chat Seek', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = html(crypto.randomBytes(16).toString('hex'));
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async m => {
      if (m.type === 'search' && typeof m.query === 'string') await search(context, m.query.slice(0, 500));
      if (m.type === 'open' && typeof m.key === 'string') {
        const uri = vscode.Uri.from({ scheme: 'chat-seek', path: '/conversation', query: m.key, fragment: String(m.line) });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    });
    await ensureIndex(context, true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chatSeek.rebuildIndex', async () => { await ensureIndex(context, true); vscode.window.showInformationMessage(`Chat Seek indexed ${index.records.length.toLocaleString()} messages.`); }));
}
async function deactivate() { if (modelPromise) try { await (await modelPromise).close(); } catch { /* shutdown */ } }
module.exports = { activate, deactivate, openConversation };

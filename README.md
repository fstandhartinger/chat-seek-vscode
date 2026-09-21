# Chat Seek

A VS Code extension for finding past **Claude Code, Codex, and OpenCode** conversations from a plain language description.

![Chat Seek demo](media/demo.gif)

[Download the X demo video](media/demo.mp4) · [Watch the narrated explainer](media/explainer.mp4). Demo excerpts are illustrative.

Chat Seek indexes local user and assistant messages, shortlists candidates by their words, then uses the [Laya local decision model](https://github.com/receptron/laya) to judge which conversations fit your description. Search results open as readable conversation excerpts in VS Code. No chat text is sent to a server.

## Install

Use Node.js 20+ on Linux x64 (including VS Code Remote WSL):

```sh
npm install
npm run package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `chat-seek-linux-x64-0.1.1.vsix`. Run **Chat Seek: Search past AI chats** from the Command Palette.

The packaged VSIX targets Linux x64. To build for another platform, install the dependencies on that platform and adjust the packaging target and `.vscodeignore` native-binary exclusions.

Opening Chat Seek builds or refreshes a local index in VS Code's private extension storage. The first Laya search downloads roughly 1.7 GB of model weights to `~/.cache/receptron-laya`; subsequent rankings stay local. A search displays keyword results first, then updates the order when Laya finishes. If the model cannot load, keyword results remain usable. Set `chatSeek.useLaya` to `false` for keyword-only search.

Run **Chat Seek: Rebuild chat index** for a manual refresh while the search panel is open. Changed transcript files are rescanned; unchanged files are loaded from the private index.

## Supported history

- `~/.claude/projects` and `~/.claude/archived_projects`
- `~/.codex/sessions` and `~/.codex/archived_sessions`
- `~/.local/share/opencode/storage`

Use `chatSeek.extraRoots` for Windows mounts or custom locations. The source is inferred from a path containing `codex` or `opencode`; all other extra roots are treated as Claude Code. Only user and assistant text is indexed; tool results are excluded. Subagent transcripts are excluded.

## Privacy and limitations

The index stays in VS Code's local extension storage and may contain private chat text. No transcripts or indexes belong in this repository. Model weights and index data are not packaged into the extension. Search relies on a word overlap shortlist, so a query with no shared words can miss a relevant chat even when Laya is enabled. Long messages are clipped at 2,800 characters; conversation previews show nearby indexed messages.

## Development

```sh
npm test
npm run lint
npm run package
```

Press F5 in VS Code to launch an Extension Development Host, then run the search command.

MIT license. Laya weights are provided separately under Apache 2.0.

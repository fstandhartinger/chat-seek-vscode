'use strict';

const approaches = Object.freeze([
  { id: 'auto', label: 'Auto (recommended)', hint: 'Choose chat search or a complete answer scan based on the query.' },
  { id: 'chat', label: 'Find a chat', hint: 'Search the local message index, then rerank likely chats with Laya.' },
  { id: 'literal', label: 'Exact terms in originals', hint: 'Search original messages for all significant query words, using archive-wide ripgrep when available. No model or API is used; show up to 100 matches.' },
  { id: 'quick', label: 'Quick answer', hint: 'Check likely original messages and exact term matches with Laya. Stop before the full archive scan.' },
  { id: 'full', label: 'Complete answer scan', hint: 'Run the quick passes, then check every original chat chunk with Laya. This can take hours.' }
]);

function normalizeApproach(value) {
  return approaches.some(x => x.id === value) ? value : 'auto';
}

module.exports = { approaches, normalizeApproach };

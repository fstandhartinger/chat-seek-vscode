'use strict';
function timestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}
function relativeTime(value, now = Date.now()) {
  const time = timestamp(value); if (!Number.isFinite(time)) return 'Date unknown';
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return 'just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  const [size, unit] = units.find(([size]) => seconds >= size);
  const n = Math.floor(seconds / size); return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}
function resumeSpec(record) {
  const uuid = record.session?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
  if (record.source === 'Claude Code' && uuid) return { executable: 'claude', args: ['--resume', uuid] };
  if (record.source === 'Codex' && uuid) return { executable: 'codex', args: ['resume', uuid] };
  if (record.source === 'OpenCode' && /^ses_[a-zA-Z0-9]+$/.test(record.session)) return { executable: 'opencode', args: ['--session', record.session] };
  return null;
}
module.exports = { timestamp, relativeTime, resumeSpec };

// ── Debug logger (Phase 4) ──
//
// A lightweight, batched, structured logger so a running simulation leaves a
// readable trace on disk (logs/sim.jsonl via the dev-server /api/log endpoint)
// AND in the browser console. Built for FOLLOWING A RUN: every meaningful tech /
// discovery event becomes one record you can grep, tail, or replay.
//
// Usage:  import { simlog } from './log.js';
//         simlog('discovery.mint', { person, recipe, day }, 'Elara invented Fired Clay');
//
// Records are { t (iso-ish tick stamp), day, evt, msg, ...fields }. They batch in
// memory and flush every FLUSH_MS or when the buffer fills — never blocks the
// tick loop. Disk write is fire-and-forget; console output is immediate.

const FLUSH_MS = 2000;
const MAX_BUFFER = 50;

let buffer = [];
let timer = null;
let enabled = true;
let toConsole = true;
let seq = 0;

// Per-event console styling so a live run is scannable. Anything not listed
// prints plain.
const STYLE = {
  'discovery.gate.pass':  'color:#3a3',
  'discovery.gate.reject':'color:#c63',
  'discovery.mint':       'color:#0a0;font-weight:bold',
  'discovery.prototype':  'color:#39c',
  'discovery.breakthrough':'color:#0a0;font-weight:bold',
  'discovery.fail':       'color:#999',
  'tech.forgotten':       'color:#c33;font-weight:bold',
  'metrics':              'color:#849',
};

function scheduleFlush() {
  if (timer || typeof fetch === 'undefined') return;
  timer = setTimeout(flush, FLUSH_MS);
}

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length || typeof fetch === 'undefined') return;
  const batch = buffer;
  buffer = [];
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => {}); // server may be down (prod build) — disk log is best-effort
}

// Emit one structured record. `fields` is merged into the record (keep it small
// and JSON-safe — pass ids/names, not whole objects). `msg` is the human line.
export function simlog(evt, fields = {}, msg = '') {
  if (!enabled) return;
  const rec = { seq: seq++, evt, msg, ...sanitize(fields) };
  buffer.push(rec);
  if (toConsole && typeof console !== 'undefined') {
    const style = STYLE[evt];
    const head = `%c[${evt}]`;
    if (style) console.log(head, style, msg || '', fields);
    else console.log(`[${evt}]`, msg || '', fields);
  }
  if (buffer.length >= MAX_BUFFER) flush();
  else scheduleFlush();
}

// Keep records flat & serializable: drop functions, trim deep objects to a name.
function sanitize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || typeof v === 'function') continue;
    if (typeof v === 'object') {
      // collapse common rich objects to something loggable
      if (v.name) out[k] = v.name;
      else if (Array.isArray(v)) out[k] = v.slice(0, 8);
      else out[k] = v;
    } else out[k] = v;
  }
  return out;
}

// Runtime toggles (e.g. from a god-power/debug switch).
export function setLogging({ disk, console: c } = {}) {
  if (typeof disk === 'boolean') enabled = disk;
  if (typeof c === 'boolean') toConsole = c;
}

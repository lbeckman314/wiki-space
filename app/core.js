// Shared constants, helpers and state. Every other module imports from here; this one imports nothing.

export const STREAM = 'https://stream.wikimedia.org/v2/stream/recentchange';
export const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/';
export const TOP_WIKIS = new Set(['en', 'de', 'fr', 'es', 'ja', 'ru', 'it', 'zh', 'pt', 'ar', 'pl', 'nl', 'fa', 'uk', 'he', 'sv', 'ko', 'tr', 'id', 'vi']);

export const MAX_POINTS = 400;       // persistent dots
export const POINT_LIFE = 10 * 60e3; // dots fade out over 10 minutes
export const RING_LIFE = 3000;
export const LABEL_LIFE = 6000;
export const MAX_LABELS = 6;
export const MAX_TICKER = 60;
export const MAX_UNPLACED = 5000;    // unplaced edits kept for the Unplaced tab and search
export const MAX_HISTORY = 50000;    // placed edits kept in memory (the list and the globe's window)

// Teal / orange-red / purple: checked with a colour-vision validator against the page background,
// so additions, removals and new articles stay distinguishable with red-green colour blindness.
export const COLORS = { add: [20, 166, 160], remove: [226, 96, 63], new: [154, 108, 240], neutral: [154, 163, 181] };
export const BAR_ADD = COLORS.add, BAR_REMOVE = COLORS.remove;

// ---------------- helpers ----------------
export const $ = id => document.getElementById(id);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const pad = n => String(n).padStart(2, '0');
export function fmtRA(ra) { const h = ((ra % 360) + 360) % 360 / 15; const m = (h % 1) * 60; return `${Math.floor(h)}h ${pad(Math.floor(m))}m ${pad(Math.round((m % 1) * 60) % 60)}s`; }
export function fmtDec(dec) { const a = Math.abs(dec); const m = (a % 1) * 60; return `${dec < 0 ? '−' : '+'}${Math.floor(a)}° ${pad(Math.floor(m))}′`; }
export const fmtDelta = d => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toLocaleString();
export const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function fmtAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s ago`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m ago`;
}
// Browser storage can be unavailable (private mode, blocked), so every access is guarded.
// Settings in the address (see "Settings in the address" in CLAUDE.md). The address is the only place settings
// are kept: a plain address always opens DEFAULTS. Changing a setting rewrites the address, leaving out values
// that match the default, so the current address is always a link to what's on screen.
export function urlParam(key, allowed) {
  const v = new URLSearchParams(location.search).get(key);
  return allowed.includes(v) ? v : null;
}
export function setUrlParam(key, value, fallback) {
  try {
    const u = new URL(location.href);
    value === fallback ? u.searchParams.delete(key) : u.searchParams.set(key, value);
    if (u.href !== location.href) history.replaceState(history.state, '', u);
  } catch (e) { /* not updated */ }
}

// ---------------- reduced motion ----------------
// Follow the system setting: camera moves jump instead of gliding, ripples are skipped, and the globes
// start without auto-rotation (the pause/play buttons can still turn it on).
export const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export const motion = { reduce: !!(motionQuery && motionQuery.matches) };
export const glide = ms => (motion.reduce ? 0 : ms);

// Edits older than this when they are placed (catch-up after a pause, slow lookups) are added quietly.
const FRESH_MS = 60e3;
export const isFresh = item => Date.now() - item.time < FRESH_MS;

// ---------------- defaults ----------------
// What the page shows with nothing saved and nothing in the address. Each key is also the address parameter
// (?sidebar=0, ?sky=1, ?points=markers, ?height=bytes, ?wikis=en); values equal to these are
// left out of the address. Change a default here and nowhere else.
export const DEFAULTS = {
  sidebar: true,   // panels: shown or hidden
  sky: false,
  points: 'bars',  // 'bars', 'markers' or 'heatmap'
  height: 'edits', // bar height: 'edits' or 'bytes'
  wikis: 'en',    // 'top' (top 20 languages), 'en' or 'all'
};

// ---------------- shared state ----------------
export const state = {
  mode: DEFAULTS.wikis,
  showApprox: true,
  pointStyle: DEFAULTS.points, // 'bars', 'markers' or 'heatmap'
  barMetric: DEFAULTS.height === 'bytes' ? 'bytes' : 'count', // bar height: 'count' (edits) or 'bytes' (bytes changed, log scale)
  follow: false,
  rotate: !motion.reduce,
  hovering: false,       // the mouse is over the Earth: rotation pauses so things hold still to be clicked
  paused: false,
  sound: false,
  unplacedList: [], // edits that could not be placed, oldest first
  history: [],      // every placed edit (Earth and sky) this session, ordered by edit time
  points: [],       // Earth edits on screen: the POINT_LIFE window before the playhead, oldest first
  groups: [],       // points merged into on-screen clusters (see points.js)
  rings: [],
  labels: [],
  selected: null,
  // stats
  considered: [], // when accepted article edits were made (for the per-minute rate)
  resolved: 0, placed: 0, exact: 0, approx: 0, sky: 0, offworld: 0, unplaced: 0,
};

// Work the update loops should do on their next pass (see main.js).
export const flags = {
  dirty: false,        // a ripple was added: re-cluster and re-send rings
  labelsDirty: false,  // a floating title was added: re-send the label layer
  windowDirty: false,  // the edits on screen changed (new edit, playhead moved)
  listDirty: true,     // the sidebar list needs rebuilding
};

// The moment the globes show. Always live ("now") since the timeline bar was removed; tl.t is kept so a
// playhead can come back without touching the rest of the app.
export const tl = { live: true, playing: true, t: Date.now(), speed: 60, dragging: false, lastWall: performance.now(), lastLabel: 0 };
export function clockNow() { return tl.live ? Date.now() : tl.t; }

// Which panels are shown (see sidebar.js).
export const view = { sidebar: DEFAULTS.sidebar, sky: DEFAULTS.sky };

// First index in state.history whose edit time is after t (history is ordered by time).
export function upperBound(t) {
  const h = state.history;
  let lo = 0, hi = h.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid].time <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

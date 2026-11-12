// Shared constants, small helpers, settings and state. Every other module imports from here;
// this one imports nothing.

// ---------------- constants ----------------
export const STREAM = 'https://stream.wikimedia.org/v2/stream/recentchange';
export const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/';
export const TOP_WIKIS = new Set(['en', 'de', 'fr', 'es', 'ja', 'ru', 'it', 'zh', 'pt', 'ar', 'pl', 'nl', 'fa', 'uk', 'he', 'sv', 'ko', 'tr', 'id', 'vi']);

export const POINT_LIFE = 10 * 60e3; // edits stay on the Earth for 10 minutes, fading as they age
export const MAX_POINTS = 400;       // most edits drawn on the Earth at once
export const RING_LIFE = 3000;       // ripple length, ms
export const LABEL_LIFE = 6000;      // floating title length, ms
export const MAX_LABELS = 6;         // floating titles on screen at once
export const MAX_LIST = 60;          // rows drawn in the sidebar list
export const MAX_UNPLACED = 5000;    // unplaced edits kept for the Unplaced tab and search
export const MAX_HISTORY = 50000;    // placed edits kept in memory

// Teal / orange-red / purple for added / removed / new. Checked with a colour-vision validator against the
// page background, so they stay distinguishable with red-green colour blindness. (sky.js has a copy.)
export const COLORS = { add: [20, 166, 160], remove: [226, 96, 63], new: [154, 108, 240], neutral: [154, 163, 181] };

// ---------------- helpers ----------------
export const $ = id => document.getElementById(id);
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

// +1,234 / −56 / ±0
export const fmtDelta = d => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toLocaleString();
export const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Right ascension in degrees → "5h 55m 10s"; declination → "+7° 24′".
const pad = n => String(n).padStart(2, '0');
export function fmtRA(ra) {
  const hours = (((ra % 360) + 360) % 360) / 15;
  const min = (hours % 1) * 60;
  return `${Math.floor(hours)}h ${pad(Math.floor(min))}m ${pad(Math.round((min % 1) * 60) % 60)}s`;
}
export function fmtDec(dec) {
  const a = Math.abs(dec);
  return `${dec < 0 ? '−' : '+'}${Math.floor(a)}° ${pad(Math.floor((a % 1) * 60))}′`;
}

// ---------------- reduced motion ----------------
// With the system's reduced-motion setting on, camera moves jump instead of gliding, ripples are skipped
// and the globes don't turn by themselves.
export const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const motion = { reduce: motionQuery.matches };
export const glide = ms => (motion.reduce ? 0 : ms);

// ---------------- settings in the address ----------------
// What a plain address opens. Each key is also an address parameter (?sidebar=0, ?sky=1, ?follow=0,
// ?points=markers, ?wikis=all). Settings are kept only in the address, never in the browser, and values
// equal to these defaults are left out of it. Change a default here and nowhere else.
export const DEFAULTS = {
  sidebar: true,  // sidebar shown
  sky: false,     // sky map folded up
  follow: true,   // turn the globes to each new edit
  points: 'bars', // 'bars' or 'markers'
  wikis: 'en',    // 'en' (English), 'top' (20 biggest languages) or 'all'
};

// The address's value for `key`, if it's one of `allowed`; otherwise null.
export function urlParam(key, allowed) {
  const v = new URLSearchParams(location.search).get(key);
  return allowed.includes(v) ? v : null;
}
// Write a setting into the address (without reloading), leaving it out when it equals the default.
export function setUrlParam(key, value, defaultValue) {
  const u = new URL(location.href);
  if (value === defaultValue) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  if (u.href !== location.href) history.replaceState(history.state, '', u);
}

// ---------------- shared state ----------------
export const state = {
  mode: DEFAULTS.wikis,         // which wikis to watch
  pointStyle: DEFAULTS.points,
  follow: DEFAULTS.follow,
  showApprox: true,             // the Approximate checkbox
  rotate: !motion.reduce,       // the Earth turns by itself
  hovering: false,              // the mouse is over the Earth, so it holds still
  pointHover: null,             // the bar or marker right under the mouse (globe.gl's own hit test)
  near: null,                   // the bar or marker the mouse is aiming at (points.js)
  selected: null,               // the edit open in the card

  history: [],      // every placed edit (Earth and sky), ordered by when it was made
  unplacedList: [], // edits that couldn't be placed, oldest first
  points: [],       // Earth edits on screen: the last POINT_LIFE of history, oldest first
  groups: [],       // points merged into clusters (points.js)
  rings: [],        // ripples on the Earth
  labels: [],       // floating titles on the Earth

  placed: 0, unplaced: 0, sky: 0, // counts for the sidebar tabs
  considered: [],   // when each kept edit arrived, for the API panel's per-minute count
};

// Work for the update loop in main.js to do on its next pass. Set a flag; don't redraw from event handlers.
export const flags = {
  dirty: false,       // a ripple was added: re-cluster and re-send ripples
  labelsDirty: false, // a floating title was added: re-send the titles
  windowDirty: false, // history changed: recompute the edits on screen
  listDirty: true,    // the sidebar list needs rebuilding
};

// Which panels are shown (sidebar.js).
export const view = { sidebar: DEFAULTS.sidebar, sky: DEFAULTS.sky };

// First index in state.history whose edit was made after time t (binary search; history is sorted by time).
export function indexAfter(t) {
  const h = state.history;
  let lo = 0, hi = h.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

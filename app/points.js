// How edits are drawn on the Earth: clustered into groups, then shown as bars (default) or numbered markers.
// Also the aiming help that makes the small bars and markers easy to hover and click.
// globe.js's layers call markerRadius, groupTooltip and barTooltip, so those are function declarations.
import { $, esc, fmtDelta, plural, state, setUrlParam, DEFAULTS } from './core.js';
import { world, wrap } from './globe.js';
import { select } from './card.js';

// ---------------- clustering ----------------
// Edits in the same grid cell form one group. The cell size follows the camera altitude, so groups split
// apart as you zoom in. Exact and approximate edits are never grouped together.
let clusterAlt = 2.4; // camera altitude at the last clustering
const cellSize = alt => Math.min(5, Math.max(0.01, alt * 0.7)); // in degrees

// True when the camera has zoomed enough since the last clustering to need a new one.
export const zoomChanged = alt => Math.abs(alt - clusterAlt) / clusterAlt > 0.12;
export const groupOf = item => state.groups.find(g => g.items.includes(item));

export function buildGroups() {
  clusterAlt = world.pointOfView().altitude;
  const cell = cellSize(clusterAlt);
  const byCell = new Map();
  for (const p of state.points) {
    const exact = p.tier === 'exact';
    if (!exact && !state.showApprox) continue;
    const key = `${exact ? 'e' : 'a'}${Math.floor(p.lat / cell)},${Math.floor(p.lng / cell)}`;
    if (!byCell.has(key)) byCell.set(key, { exact, items: [] });
    byCell.get(key).items.push(p);
  }
  state.groups = [...byCell.values()];
  for (const g of state.groups) {
    g.n = g.items.length;
    g.latest = g.items[g.n - 1]; // points are oldest first
    g.lat = g.items.reduce((s, p) => s + p.lat, 0) / g.n;
    g.lng = g.items.reduce((s, p) => s + p.lng, 0) / g.n;
  }
  if (state.pointStyle === 'bars') world.pointsData(buildBars()).labelsData([]);
  else world.pointsData(state.groups).labelsData(state.groups.filter(g => g.n > 1));
  aimAgain();
}

export function setPointStyle(style) {
  state.pointStyle = style === 'markers' ? 'markers' : 'bars';
  document.body.classList.toggle('points-bars', state.pointStyle === 'bars');
  for (const b of $('point-style').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.style === state.pointStyle));
  buildGroups();
  setUrlParam('points', state.pointStyle, DEFAULTS.points);
}

// ---------------- markers ----------------
// Radius in degrees. It scales with the camera altitude, so a marker keeps about the same size on screen,
// and grows with the number of edits in it.
export function markerRadius(g) {
  const base = (g.exact ? 0.28 : 0.32) * clusterAlt;
  const growth = Math.min(3, 1 + 0.35 * Math.sqrt(g.n - 1));
  return base * growth * (g.items.includes(state.selected) ? 1.25 : 1);
}

export function groupTooltip(g) {
  if (g.n === 1) {
    const d = g.latest;
    return `<div class="tip"><b>${esc(d.title)}</b><span>${esc(d.lang)}.wikipedia · ${fmtDelta(d.delta)} · ${esc(d.reason)}</span></div>`;
  }
  const recent = g.items.slice(-6).reverse().map(d => `<li>${esc(d.title)} <span>${esc(d.lang)}</span></li>`).join('');
  const where = g.exact ? 'nearby' : esc(g.latest.reason);
  const more = g.n > 6 ? `+${g.n - 6} more · click to see all` : 'click to open';
  return `<div class="tip"><b>${g.n} edits · ${where}</b><ul>${recent}</ul><span>${more}</span></div>`;
}

// ---------------- bars ----------------
// Each group gets up to two bars side by side: additions and new articles on the left, removals on the
// right, so position tells them apart as well as colour. Height is the number of edits, scaled to the
// tallest bar on screen (but never as if fewer than 6 were the most), and shrinks as you zoom in.
function buildBars() {
  const bars = [];
  for (const g of state.groups) {
    const sides = {
      add: g.items.filter(p => p.kind === 'add' || p.kind === 'new'),
      remove: g.items.filter(p => p.kind === 'remove'),
    };
    for (const [side, items] of Object.entries(sides)) {
      if (items.length) bars.push({ bar: true, side, group: g, items, latest: items[items.length - 1] });
    }
  }
  const tallest = Math.max(6, ...bars.map(b => b.items.length));
  const zoom = Math.min(1, clusterAlt / 2.4);
  const r = 0.17 * clusterAlt; // radius in degrees: about the same size on screen at any zoom
  for (const b of bars) {
    const gap = (r * 1.1) / Math.max(0.2, Math.cos((b.group.lat * Math.PI) / 180)); // half the distance between the pair
    b.lat = b.group.lat;
    b.lng = b.group.lng + (b.side === 'add' ? -gap : gap);
    b.r = r;
    b.alt = Math.max(0.012, 0.25 * (b.items.length / tallest)) * zoom; // even one edit stands up a little
  }
  return bars;
}

export function barTooltip(b) {
  const n = b.items.length;
  const created = b.items.filter(p => p.kind === 'new').length;
  const bytes = b.items.reduce((s, p) => s + Math.abs(p.delta), 0);
  const what = b.side === 'add'
    ? plural(n, 'addition') + (created ? ` (${plural(created, 'new article')})` : '')
    : plural(n, 'removal');
  const where = b.group.exact ? 'nearby' : esc(b.latest.reason);
  const recent = b.items.slice(-4).reverse().map(d => `<li>${esc(d.title)} <span>${fmtDelta(d.delta)}</span></li>`).join('');
  return `<div class="tip"><b>${what} · ${where}</b><span>${b.side === 'add' ? '+' : '−'}${bytes.toLocaleString()} bytes in total</span>` +
    `<ul>${recent}</ul><span>click to open the newest</span></div>`;
}

// ---------------- aiming help ----------------
// Bars and markers are only a few pixels wide, so the pointer doesn't have to land exactly on one: the nearest
// within REACH pixels lights up, shows its tooltip and opens on click. Distance is measured on screen to the
// whole bar, from base to top, and only things on the near side of the Earth count.
const REACH = { mouse: 22, pen: 22, touch: 38 };
const reachFor = e => REACH[e.pointerType] || REACH.mouse;

function nearestTo(clientX, clientY, reach) {
  const box = wrap.getBoundingClientRect();
  const x = clientX - box.left, y = clientY - box.top;
  const cam = world.camera().position;
  let best = null, bestDist = reach;
  for (const d of world.pointsData()) {
    const p = world.getCoords(d.lat, d.lng, 0);
    const facingUs = p.x * (cam.x - p.x) + p.y * (cam.y - p.y) + p.z * (cam.z - p.z) > 0;
    if (!facingUs) continue;
    const base = world.getScreenCoords(d.lat, d.lng, 0);
    const top = d.bar ? world.getScreenCoords(d.lat, d.lng, d.alt) : base;
    // A marker is a disc: anywhere inside its radius counts as on it.
    const radius = d.bar ? 0 : distance(base, world.getScreenCoords(d.lat + markerRadius(d), d.lng, 0));
    const dist = Math.max(0, distanceToSegment({ x, y }, base, top) - radius);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Light up `d` (or nothing) and place the tooltip next to the pointer.
let pointer = null; // last mouse position over the Earth, or null
function aimAt(d) {
  const tip = $('near-tip');
  if (d !== state.near) {
    state.near = d;
    world.pointColor(world.pointColor()); // re-colour so it lights up
    wrap.classList.toggle('aiming', !!d);
    if (d) tip.innerHTML = d.bar ? barTooltip(d) : groupTooltip(d);
  }
  // Right on a bar or marker, globe.gl shows its own tooltip; ours is for near misses.
  tip.hidden = !d || !pointer || !!state.pointHover;
  if (tip.hidden) return;
  const box = wrap.getBoundingClientRect();
  tip.style.left = Math.min(pointer.x - box.left + 14, box.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.max(8, pointer.y - box.top - tip.offsetHeight - 12) + 'px';
}
// Bars and markers are rebuilt every few seconds: aim again from where the pointer is.
function aimAgain() {
  state.near = null;
  aimAt(pointer ? nearestTo(pointer.x, pointer.y, pointer.reach) : null);
}

export function initPoints() {
  let downAt = null, timer = null;
  wrap.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
  wrap.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || e.buttons) { pointer = null; aimAt(null); return; } // dragging the globe
    pointer = { x: e.clientX, y: e.clientY, reach: reachFor(e), onTitle: !!e.target.closest('.glabel') };
    timer ??= setTimeout(() => { // at most ~30 checks a second
      timer = null;
      if (pointer) aimAt(pointer.onTitle ? null : nearestTo(pointer.x, pointer.y, pointer.reach));
    }, 30);
  });
  wrap.addEventListener('pointerleave', () => { pointer = null; aimAt(null); });
  wrap.addEventListener('click', e => {
    if (!downAt || e.target.closest('.glabel')) return; // floating titles handle their own clicks
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // it was a drag
    if (state.pointHover) return; // right on a bar or marker: globe.gl's own click opens it
    const d = nearestTo(e.clientX, e.clientY, reachFor(e));
    if (d) select(d.latest);
  });
}

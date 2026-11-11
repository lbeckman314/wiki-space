// How edits on the Earth are drawn: clustered markers (default), bars, or a heatmap.
// Functions the globe's layers call (markerRadius, groupTooltip, barTooltip, heatBandwidth, heatColor) are
// function declarations, so they exist as soon as the module graph is linked.
import { $, POINT_LIFE, esc, fmtDelta, state, clockNow, setUrlParam, DEFAULTS } from './core.js';
import { world, wrap } from './globe.js';
import { select } from './card.js';

// ---------------- clustering ----------------
// Edits are merged into one marker when they fall in the same grid cell. The cell size follows the
// camera altitude, so clusters split apart as you zoom in. Exact and approximate edits never merge
// with each other; approximate edits share their place's coordinates, so each place becomes one marker.
let clusterAlt = 2.4;
// Marker radius in degrees. It scales with camera altitude, so a marker keeps roughly the same size
// on screen at any zoom, and grows with the number of edits it holds.
export function markerRadius(g) {
  const base = (g.exact ? 0.28 : 0.32) * clusterAlt;
  return base * Math.min(3, 1 + 0.35 * Math.sqrt(g.n - 1)) * (g.items.includes(state.selected) ? 1.25 : 1);
}
const cellSize = alt => Math.min(5, Math.max(0.01, alt * 0.7)); // wider than a marker, so neighbours rarely overlap

export const visiblePoints = () => (state.showApprox ? state.points.slice() : state.points.filter(p => p.tier === 'exact'));
export const groupOf = item => state.groups.find(g => g.items.includes(item));
// True when the camera has zoomed enough since the last clustering for the clusters to need rebuilding.
export const zoomChanged = alt => Math.abs(alt - clusterAlt) / clusterAlt > 0.12;

export function buildGroups() {
  clusterAlt = world.pointOfView().altitude;
  const cell = cellSize(clusterAlt);
  const byCell = new Map();
  for (const p of visiblePoints()) {
    const exact = p.tier === 'exact';
    const key = (exact ? 'e' : 'a') + Math.floor(p.lat / cell) + ',' + Math.floor(p.lng / cell);
    let g = byCell.get(key);
    if (!g) { g = { key, exact, items: [] }; byCell.set(key, g); }
    g.items.push(p);
  }
  state.groups = [...byCell.values()].map(g => {
    g.n = g.items.length;
    g.latest = g.items[g.n - 1]; // points are kept oldest-first
    g.lat = g.items.reduce((s, p) => s + p.lat, 0) / g.n;
    g.lng = g.items.reduce((s, p) => s + p.lng, 0) / g.n;
    return g;
  });
  if (state.pointStyle === 'heatmap') {
    // Only the selected edit keeps a marker; everything else is drawn by the heatmap.
    world.pointsData(state.groups.filter(g => g.items.includes(state.selected))).labelsData([]);
    scheduleHeatmap();
  } else if (state.pointStyle === 'bars') {
    world.pointsData(buildBars()).labelsData([]);
  } else {
    world.pointsData(state.groups).labelsData(state.groups.filter(g => g.n > 1));
  }
  refreshNear();
}

export function groupTooltip(g) {
  if (g.n === 1) {
    const d = g.latest;
    return `<div class="tip"><b>${esc(d.title)}</b><span>${esc(d.lang)}.wikipedia · ${fmtDelta(d.delta)} · ${esc(d.reason)}</span></div>`;
  }
  const recent = g.items.slice(-6).reverse().map(d => `<li>${esc(d.title)} <span>${esc(d.lang)}</span></li>`).join('');
  const where = g.exact ? 'nearby' : esc(g.latest.reason);
  return `<div class="tip"><b>${g.n} edits · ${where}</b><ul>${recent}</ul>${g.n > 6 ? `<span>+${g.n - 6} more · click to see all</span>` : '<span>click to open</span>'}</div>`;
}

// ---------------- bars point style ----------------
// Each cluster gets up to two columns side by side: additions (incl. new articles) to the west,
// removals to the east, so position tells them apart as well as colour. Height is the number of edits,
// or total bytes changed on a log scale. Heights are scaled to the tallest bar on screen, with a floor
// so a handful of edits doesn't look like a skyscraper, and shrink as you zoom in.
const barValue = items => (state.barMetric === 'bytes' ? items.reduce((s, p) => s + Math.abs(p.delta), 0) : items.length);
const barScale = v => (state.barMetric === 'bytes' ? Math.log10(1 + v) : v);
function buildBars() {
  const bars = [];
  for (const g of state.groups) {
    const adds = g.items.filter(p => p.kind === 'add' || p.kind === 'new');
    const removes = g.items.filter(p => p.kind === 'remove');
    for (const [side, items] of [['add', adds], ['remove', removes]]) {
      if (items.length) bars.push({ bar: true, side, group: g, items, latest: items[items.length - 1], v: barValue(items) });
    }
  }
  const floor = state.barMetric === 'bytes' ? barScale(5000) : 6; // the scale never tops out below this
  const top = Math.max(floor, ...bars.map(b => barScale(b.v)));
  const zoom = Math.min(1, clusterAlt / 2.4);
  const r = 0.17 * clusterAlt; // bar radius in degrees: constant on screen, like the markers, and wide enough to hover
  for (const b of bars) {
    const off = (r * 1.1) / Math.max(0.2, Math.cos((b.group.lat * Math.PI) / 180)); // a narrow gap between the pair
    b.lat = b.group.lat;
    b.lng = b.group.lng + (b.side === 'add' ? -off : off);
    b.r = r;
    b.alt = Math.max(0.012 * zoom, 0.25 * zoom * (barScale(b.v) / top)); // even one edit stands up a little
  }
  return bars;
}
export function barTooltip(b) {
  const n = b.items.length;
  const fresh = b.items.filter(p => p.kind === 'new').length;
  const bytes = b.items.reduce((s, p) => s + Math.abs(p.delta), 0);
  const what = b.side === 'add' ? `${n} addition${n === 1 ? '' : 's'}${fresh ? ` (${fresh} new article${fresh === 1 ? '' : 's'})` : ''}` : `${n} removal${n === 1 ? '' : 's'}`;
  const where = b.group.exact ? 'nearby' : esc(b.latest.reason);
  const recent = b.items.slice(-4).reverse().map(d => `<li>${esc(d.title)} <span>${fmtDelta(d.delta)}</span></li>`).join('');
  return `<div class="tip"><b>${what} · ${where}</b><span>${b.side === 'add' ? '+' : '−'}${bytes.toLocaleString()} bytes in total</span><ul>${recent}</ul><span>click to open the newest</span></div>`;
}

// ---------------- heatmap point style ----------------
// three-globe estimates density at every vertex of a sphere whose detail follows the bandwidth
// (a 2° bandwidth is ~200k vertices). With WebGPU that runs on the GPU; without it (Chrome on Linux,
// older Safari/Firefox) it runs on the main thread. To keep that affordable:
//   - the heatmap is fed one weighted point per cluster, not one per edit;
//   - the bandwidth has three fixed steps (2°, 3°, 4°) instead of following every zoom change;
//   - it is refreshed at most every 8 s, and only when its input changed;
//   - the same dataset object is reused, so the layer updates in place instead of being rebuilt.
// three-globe takes its WebGPU route whenever navigator.gpu exists, but some browsers expose it with no
// usable adapter, and then the heatmap comes out empty. In that case hide navigator.gpu from it, so it
// uses its CPU route instead.
const gpuChecked = (async () => {
  try {
    if (navigator.gpu && !(await navigator.gpu.requestAdapter())) {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    }
  } catch (e) { /* keep whatever the browser offers */ }
})();
export function heatBandwidth() { return clusterAlt > 1.6 ? 4 : clusterAlt > 0.7 ? 3 : 2; }
// Colour scale (same stops as the legend): blue → cyan → green → amber → red, never fully opaque,
// so the globe stays visible under the heat.
const HEAT_STOPS = [[0, [70, 134, 251]], [0.3, [26, 228, 182]], [0.55, [162, 252, 60]], [0.78, [250, 187, 57]], [1, [228, 70, 10]]];
export function heatColor(t) {
  t = Math.min(1, Math.max(0, t));
  let k = 1;
  while (k < HEAT_STOPS.length - 1 && t > HEAT_STOPS[k][0]) k++;
  const [t0, c0] = HEAT_STOPS[k - 1], [t1, c1] = HEAT_STOPS[k];
  const f = (t - t0) / (t1 - t0 || 1);
  const c = c0.map((v, i) => Math.round(v + (c1[i] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${(0.75 * Math.cbrt(t)).toFixed(3)})`;
}
const heatWeight = p => {
  const age = Math.min(1, Math.max(0, (clockNow() - p.time) / POINT_LIFE));
  return (p.tier === 'exact' ? 1 : 0.45) * (1 - 0.85 * age); // recent and exact edits count most
};
const heatDataset = { points: [] };
let heatTimer = null, lastHeat = 0, heatSig = '';
function scheduleHeatmap(force) {
  if (heatTimer && !force) return;
  clearTimeout(heatTimer);
  heatTimer = setTimeout(async () => {
    heatTimer = null;
    await gpuChecked;
    if (state.pointStyle !== 'heatmap') return;
    const pts = state.groups.map(g => ({ lat: g.lat, lng: g.lng, w: g.items.reduce((s, p) => s + heatWeight(p), 0) }));
    const sig = heatBandwidth() + ':' + pts.length + ':' + pts.reduce((s, p) => s + p.w, 0).toFixed(1);
    if (sig === heatSig && !force) return;
    heatSig = sig;
    lastHeat = Date.now();
    heatDataset.points = pts;
    world.heatmapsData(pts.length ? [heatDataset] : []);
  }, force ? 0 : Math.max(0, lastHeat + 8000 - Date.now()));
}

export function setPointStyle(style) {
  state.pointStyle = ['markers', 'heatmap', 'bars'].includes(style) ? style : DEFAULTS.points;
  document.body.classList.toggle('points-heatmap', state.pointStyle === 'heatmap');
  document.body.classList.toggle('points-bars', state.pointStyle === 'bars');
  for (const b of $('point-style').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.style === state.pointStyle));
  if (state.pointStyle !== 'heatmap') world.heatmapsData([]);
  heatSig = '';
  buildGroups();
  if (state.pointStyle === 'heatmap') scheduleHeatmap(true);
  setUrlParam('points', state.pointStyle, DEFAULTS.points);
}

// ---------------- aiming help ----------------
// Bars and markers are only a few pixels wide, so the pointer doesn't have to land on one exactly: the
// nearest bar or marker within REACH pixels (more for touch) lights up, shows its tooltip and opens on click.
// Distance is measured on screen to the whole column, from its base to its top, and only to the near side
// of the globe.
const REACH = { mouse: 22, pen: 22, touch: 38 };
function nearestTarget(x, y, reach) {
  if (state.pointStyle === 'heatmap') return null;
  const cam = world.camera().position;
  let best = null, bestD = reach;
  for (const d of world.pointsData()) {
    const alt = d.bar ? d.alt : 0.0015;
    const p = world.getCoords(d.lat, d.lng, 0);
    if (p.x * (cam.x - p.x) + p.y * (cam.y - p.y) + p.z * (cam.z - p.z) <= 0) continue; // far side
    const a = world.getScreenCoords(d.lat, d.lng, 0), b = world.getScreenCoords(d.lat, d.lng, alt);
    // Markers are discs: count the pointer as on it anywhere within its radius on screen.
    const pad = d.bar ? 0 : Math.max(0, distPx(a, world.getScreenCoords(d.lat + markerRadius(d), d.lng, 0)) - 2);
    const dist = Math.max(0, segDist(x, y, a, b) - pad);
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
}
const distPx = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function segDist(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}
// Points are rebuilt every few seconds; aim again at whatever is under the (still) pointer.
let aimAt = null;
function refreshNear() {
  if (!state.near && !aimAt) return;
  if (!aimAt || state.pointStyle === 'heatmap') { setNear(null); return; }
  state.near = null; // the old object is gone; force a re-colour
  const r = wrap.getBoundingClientRect();
  setNear(nearestTarget(aimAt.clientX - r.left, aimAt.clientY - r.top, REACH[aimAt.pointerType] || 22), aimAt);
}
function setNear(d, e) {
  const tip = $('near-tip');
  if (d !== state.near) {
    state.near = d;
    world.pointColor(world.pointColor()); // re-colour so the target lights up
    wrap.classList.toggle('aiming', !!d);
    if (d) tip.innerHTML = d.bar ? barTooltip(d) : groupTooltip(d);
  }
  // globe.gl shows its own tooltip when the pointer is right on a point; ours is for near misses.
  tip.hidden = !d || !e || !!state.pointHover;
  if (!tip.hidden) {
    const r = wrap.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.max(8, e.clientY - r.top - tip.offsetHeight - 12) + 'px';
  }
}

export function initPoints() {
  let downAt = null, frame = 0, last = null;
  wrap.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  wrap.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || e.buttons) { aimAt = null; if (state.near) setNear(null); return; } // dragging the globe
    last = e;
    if (!frame) frame = setTimeout(() => { // at most ~30 checks a second
      frame = 0;
      if (last.target.closest('.glabel')) { setNear(null); return; }
      const r = wrap.getBoundingClientRect();
      aimAt = { clientX: last.clientX, clientY: last.clientY, pointerType: last.pointerType };
      setNear(nearestTarget(last.clientX - r.left, last.clientY - r.top, REACH[last.pointerType] || 22), aimAt);
    }, 30);
  });
  wrap.addEventListener('pointerleave', () => { aimAt = null; setNear(null); });
  wrap.addEventListener('click', e => {
    if (!downAt || e.target.closest('.glabel')) return; // floating titles handle their own clicks
    if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // it was a drag
    if (state.pointStyle !== 'heatmap') {
      if (state.pointHover) return; // right on a point: globe.gl's own click opens it
      const r = wrap.getBoundingClientRect();
      const d = nearestTarget(e.clientX - r.left, e.clientY - r.top, REACH[e.pointerType] || 22);
      if (d) select(d.latest);
      return;
    }
    // The heatmap has no click events, so a click on the Earth opens the newest edit near that spot.
    if (e.target.closest('.glabel')) return; // floating titles handle their own clicks
    if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // it was a drag
    const r = wrap.getBoundingClientRect();
    const at = world.toGlobeCoords(e.clientX - r.left, e.clientY - r.top);
    if (!at) return; // clicked off the globe
    const reach = heatBandwidth() * 1.5;
    let best = null;
    for (const p of visiblePoints()) {
      if (greatCircleDeg(at.lat, at.lng, p.lat, p.lng) <= reach && (!best || p.time > best.time)) best = p;
    }
    if (best) select(best);
  });
}
function greatCircleDeg(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / r;
}

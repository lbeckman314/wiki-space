// The Earth: the globe and how its layers look, ripples, floating titles, Follow and rotation.
// Which bars and markers are drawn is decided in points.js.
import Globe from 'globe.gl';
import { $, TEX, POINT_LIFE, RING_LIFE, LABEL_LIFE, MAX_LABELS, COLORS, rgba, glide, motion, state, flags } from './core.js';
import { markerRadius, groupTooltip, barTooltip } from './points.js';
import { select } from './card.js';
import { WikiSky } from './sky.js';

const WHITE = [255, 255, 255];
const lighten = c => c.map(v => Math.round(v + (255 - v) * 0.45));

// Bar or marker colour: white when selected, lighter when aimed at, otherwise its edit colour.
// Markers fade as their newest edit ages; approximate ones are fainter.
function pointColor(d) {
  const selected = d.items.includes(state.selected);
  const base = d.bar ? COLORS[d.side] : COLORS[d.latest.kind];
  if (selected) return rgba(WHITE, 0.95);
  if (d === state.near) return rgba(lighten(base), 1);
  if (d.bar) return rgba(base, 0.9);
  const age = (Date.now() - d.latest.time) / POINT_LIFE;
  return rgba(base, Math.max(0.12, (d.exact ? 0.95 : 0.45) * (1 - age)));
}

export const wrap = $('globe');
export const world = new Globe(wrap, { animateIn: true })
  .globeImageUrl(TEX + 'earth-night.jpg')
  .bumpImageUrl(TEX + 'earth-topology.png')
  .showAtmosphere(true).atmosphereColor('#5b8cff').atmosphereAltitude(0.17)
  // Bars stand up; markers are flat discs (so they don't turn into columns close up).
  .pointLat('lat').pointLng('lng')
  .pointAltitude(d => (d.bar ? d.alt : 0.0015))
  .pointRadius(d => (d.bar ? d.r : markerRadius(d)))
  .pointColor(pointColor)
  .pointResolution(24).pointsMerge(false).pointsTransitionDuration(0)
  .pointLabel(d => (d.bar ? barTooltip(d) : groupTooltip(d)))
  .onPointClick(d => select(d.latest))
  // Edit counts on markers, nudged so the number sits in the middle of the disc.
  .labelLat(g => g.lat - 0.8 * markerRadius(g)).labelLng('lng').labelText(g => String(g.n))
  .labelSize(g => markerRadius(g) * 1.05).labelDotRadius(0).labelAltitude(0.003).labelResolution(2)
  .labelColor(g => (g.items.includes(state.selected) ? 'rgba(10,14,25,0.95)' : 'rgba(255,255,255,0.95)'))
  .labelDotOrientation(() => 'top')
  .labelLabel(groupTooltip)
  .onLabelClick(g => select(g.latest))
  // Ripples
  .ringLat('lat').ringLng('lng')
  .ringColor(d => t => rgba(COLORS[d.kind], (d.tier === 'exact' ? 0.9 : 0.4) * (1 - t)))
  .ringMaxRadius('maxR').ringPropagationSpeed('speed').ringRepeatPeriod(RING_LIFE * 2)
  // Floating titles (HTML, so every script renders)
  .htmlLat('lat').htmlLng('lng').htmlAltitude(0.01)
  .htmlElement(d => d.el)
  .htmlTransitionDuration(0)
  // Titles on the far side of the Earth are hidden, so they can't be clicked either.
  .htmlElementVisibilityModifier((el, visible) => { el.style.visibility = visible ? 'visible' : 'hidden'; });

export function initGlobe() {
  WikiSky.starfield.then(url => world.backgroundImageUrl(url)); // the sky map's stars, behind the Earth
  world.controls().autoRotateSpeed = 0.35;
  world.pointOfView({ lat: 40, lng: -100, altitude: 1.8 });
  applyRotation();
  // Hold still while the mouse is over the Earth (or a bar, marker or title), so things are easy to click.
  watchHover(wrap, world, '.glabel', on => { state.hovering = on; applyRotation(); }, d => { state.pointHover = d || null; });

  const resize = () => world.width(wrap.clientWidth).height(wrap.clientHeight);
  new ResizeObserver(resize).observe(wrap);
  resize();
}

export function applyRotation() {
  world.controls().autoRotate = state.rotate && !state.follow && !state.selected && !state.hovering;
}

// A new edit on the Earth: ripple, floating title and Follow. Skipped while the tab is hidden, or they'd
// pile up and all appear at once when the tab comes back.
export function announce(item) {
  if (document.hidden) return;
  const exact = item.tier === 'exact';
  if (!motion.reduce) {
    const size = Math.log10(Math.abs(item.delta) + 10); // about 1 to 5
    state.rings.push({
      lat: item.lat, lng: item.lng, kind: item.kind, tier: item.tier, born: Date.now(),
      maxR: exact ? 1 + size * 1.1 : item.tier === 'country' ? 5 + size : 2.5 + size,
      speed: exact ? 2.5 + size : 1.4,
    });
  }
  flags.dirty = true;
  if (state.follow && !state.selected) followTo(item);
  addTitle(item, exact);
}

function addTitle(item, exact) {
  const el = document.createElement('div');
  el.className = 'glabel' + (exact ? '' : ' approx');
  const inner = document.createElement('div');
  inner.textContent = inner.title = item.title;
  // pointerdown, not click: globe.gl may re-attach title elements between press and release.
  inner.addEventListener('pointerdown', e => { e.stopPropagation(); select(item); });
  el.appendChild(inner);
  // Expired titles stay (hidden) until the next one arrives, so the layer is re-sent once per edit.
  const now = Date.now();
  state.labels = state.labels.filter(l => now - l.born < LABEL_LIFE);
  state.labels.push({ lat: item.lat, lng: item.lng, el, born: now });
  if (state.labels.length > MAX_LABELS) state.labels.shift();
  flags.labelsDirty = true;
}

// Follow: turn the Earth to the newest edit, at most every 1.5 s. When edits come faster, the camera
// catches up with the latest one once the wait is over.
let lastFollow = 0, followTimer = null, followNext = null;
export function followTo(item, now = false) {
  if (now) lastFollow = 0;
  followNext = item;
  const wait = lastFollow + 1500 - Date.now();
  if (wait > 0) {
    followTimer ??= setTimeout(() => {
      followTimer = null;
      if (state.follow && !state.selected) followTo(followNext);
    }, wait);
    return;
  }
  lastFollow = Date.now();
  world.pointOfView({ lat: item.lat, lng: item.lng, altitude: world.pointOfView().altitude }, glide(1000));
}

// Calls onChange(true/false) as the mouse moves onto or off a globe (used for both globes). "On" means over
// the sphere itself (globe.gl's toGlobeCoords), over one of its points, or over an HTML marker matching
// `htmlSelector`; empty space around the sphere doesn't count. Checked at most every 100 ms.
export function watchHover(el, globe, htmlSelector, onChange, onPoint) {
  let on = false, overPoint = false, last = 0, timer = null, pos = null;
  const set = v => { if (v !== on) { on = v; onChange(v); } };
  const check = () => {
    last = performance.now();
    timer = null;
    if (!pos) return;
    const r = el.getBoundingClientRect();
    set(overPoint || !!pos.target.closest(htmlSelector) || !!globe.toGlobeCoords(pos.x - r.left, pos.y - r.top));
  };
  el.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return; // touch already stops the rotation: dragging takes over
    pos = { x: e.clientX, y: e.clientY, target: e.target };
    if (performance.now() - last >= 100) check();
    else timer ??= setTimeout(check, 100);
  });
  el.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    timer = pos = null;
    overPoint = false;
    set(false);
  });
  globe.onPointHover(d => {
    overPoint = !!d;
    if (overPoint) set(true);
    if (onPoint) onPoint(d);
  });
}

// The Earth globe: base layers, ripples, floating titles, Follow and rotation.
// The point / label / heatmap layers are styled here but their data comes from points.js.
import { $, TEX, POINT_LIFE, RING_LIFE, LABEL_LIFE, MAX_LABELS, COLORS, BAR_ADD, BAR_REMOVE, rgba, glide, motion, state, flags, clockNow } from './core.js';
import { markerRadius, groupTooltip, barTooltip, heatBandwidth, heatColor } from './points.js';
import { select } from './card.js';

export const wrap = $('globe');
export const world = new Globe(wrap, { animateIn: true })
  .globeImageUrl(TEX + 'earth-night.jpg')
  .bumpImageUrl(TEX + 'earth-topology.png')
  .showAtmosphere(true).atmosphereColor('#5b8cff').atmosphereAltitude(0.17)
  // persistent markers: one flat disc per cluster of nearby edits, or two bars per cluster (see points.js)
  .pointLat('lat').pointLng('lng')
  // Markers are flat discs (so they don't turn into columns close up); bars stand up.
  .pointAltitude(d => (d.bar ? d.alt : 0.0015))
  .pointRadius(d => (d.bar ? d.r : markerRadius(d)))
  .pointColor(d => {
    const sel = d.items.includes(state.selected);
    if (d.bar) return rgba(sel ? [255, 255, 255] : d.side === 'add' ? BAR_ADD : BAR_REMOVE, sel ? 0.95 : 0.9);
    const age = (clockNow() - d.latest.time) / POINT_LIFE;
    return rgba(sel ? [255, 255, 255] : COLORS[d.latest.kind], sel ? 0.95 : Math.max(0.12, (d.exact ? 0.95 : 0.45) * (1 - age)));
  })
  .pointResolution(24)
  .pointsMerge(false)
  .pointsTransitionDuration(0)
  .pointLabel(d => (d.bar ? barTooltip(d) : groupTooltip(d)))
  .onPointClick(d => select(d.latest))
  // edit counts on clusters
  .labelLat(g => g.lat - 0.8 * markerRadius(g)).labelLng('lng').labelText(g => String(g.n)) // shifted so the number sits centred on the disc
  .labelSize(g => markerRadius(g) * 1.05).labelDotRadius(0).labelAltitude(0.003).labelResolution(2)
  .labelColor(g => (g.items.includes(state.selected) ? 'rgba(10,14,25,0.95)' : 'rgba(255,255,255,0.95)'))
  .labelDotOrientation(() => 'top')
  .labelLabel(g => groupTooltip(g))
  .onLabelClick(g => select(g.latest))
  // heatmap (the alternative point style): one dataset, thin and close to the surface
  .heatmapPoints('points').heatmapPointLat('lat').heatmapPointLng('lng')
  .heatmapPointWeight('w') // summed edit weights of one cluster (see points.js)
  .heatmapBandwidth(() => heatBandwidth())
  .heatmapBaseAltitude(0.002).heatmapTopAltitude(0.018)
  .heatmapColorFn(() => heatColor)
  .heatmapColorSaturation(1.15)
  .heatmapsTransitionDuration(0)
  // one-shot ripples
  .ringLat('lat').ringLng('lng')
  .ringColor(d => t => rgba(COLORS[d.kind], (d.tier === 'exact' ? 0.9 : 0.4) * (1 - t)))
  .ringMaxRadius('maxR').ringPropagationSpeed('speed').ringRepeatPeriod(RING_LIFE * 2)
  // floating title labels (HTML, so every script renders)
  .htmlLat('lat').htmlLng('lng').htmlAltitude(0.01)
  .htmlElement(d => d.el)
  .htmlTransitionDuration(0);

export function initGlobe() {
  // Hide (and make unclickable) labels that are on the far side of the Earth.
  if (typeof world.htmlElementVisibilityModifier === 'function') {
    world.htmlElementVisibilityModifier((elem, visible) => {
      elem.style.visibility = visible ? 'visible' : 'hidden';
    });
  }
  // Same star catalogue as the sky map, painted as the background sphere.
  WikiSky.starfield.then(url => world.backgroundImageUrl(url));

  world.controls().autoRotate = state.rotate;
  world.controls().autoRotateSpeed = 0.35;
  world.pointOfView({ lat: 25, lng: 10, altitude: 2.4 });

  const resize = () => world.width(wrap.clientWidth).height(wrap.clientHeight);
  new ResizeObserver(resize).observe(wrap);
  resize();
}

// Ripple, floating title, sound and Follow for one edit: on arrival when live, or when the playhead passes it.
// While the tab is hidden only sound plays (for people listening in the background); ripples, titles
// and camera moves would otherwise pile up and all appear at once when the tab comes back.
export function announce(item, { label = true, sound = true } = {}) {
  if (sound && state.sound) WikiSound.play(item);
  if (document.hidden) return;
  if (item.sky) { WikiSky.pulse(item); return; }
  const size = Math.log10(Math.abs(item.delta) + 10); // 1 .. ~5
  const exact = item.tier === 'exact';
  if (!motion.reduce) state.rings.push({
    lat: item.lat, lng: item.lng, kind: item.kind, tier: item.tier, born: Date.now(),
    maxR: exact ? 1 + size * 1.1 : item.tier === 'country' ? 5 + size : 2.5 + size,
    speed: exact ? 2.5 + size : 1.4,
  });
  flags.dirty = true;
  if (state.follow && !state.selected) followTo(item);
  if (!label) return;

  const el = document.createElement('div');
  el.className = 'glabel' + (exact ? '' : ' approx');
  const inner = document.createElement('div');
  inner.textContent = item.title;
  inner.title = item.title;
  // pointerdown rather than click: globe.gl may re-attach label elements between press and release.
  inner.addEventListener('pointerdown', e => { e.stopPropagation(); select(item); });
  el.appendChild(inner);
  // Expired labels stay (hidden) until the next new label, so the label layer is re-sent only once per edit.
  const now = Date.now();
  state.labels = state.labels.filter(l => now - l.born < LABEL_LIFE);
  state.labels.push({ lat: item.lat, lng: item.lng, el, born: now });
  if (state.labels.length > MAX_LABELS) state.labels.shift();
  flags.labelsDirty = true;
}

// Follow: centre the Earth on the newest edit (at most every 1.5 s).
// If edits arrive faster than that, the camera catches up with the latest one when the wait is over.
let lastFollow = 0, followTimer = null, followNext = null;
export function followTo(item) {
  followNext = item;
  const wait = lastFollow + 1500 - Date.now();
  if (wait > 0) {
    if (!followTimer) followTimer = setTimeout(() => { followTimer = null; if (state.follow && !state.selected) followTo(followNext); }, wait);
    return;
  }
  lastFollow = Date.now();
  world.pointOfView({ lat: item.lat, lng: item.lng, altitude: world.pointOfView().altitude }, glide(1000));
}
// Follow right away, ignoring the 1.5 s wait (used when Follow is switched on).
export function followNow(item) { lastFollow = 0; followTo(item); }
export function applyRotation() { world.controls().autoRotate = state.rotate && !state.follow && !state.selected; }

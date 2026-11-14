/*
 * Sky view: a second globe.gl globe showing the celestial sphere.
 *
 *   longitude = −right ascension   (negated, so shapes read like a sky chart instead of a mirror image)
 *   latitude  =  declination
 *
 * Also holds the astronomy helpers used by geo.js:
 *   planetPosition(qid, date)  Sun, Moon, planets, Pluto via astronomy-engine
 *   orbitPosition(elements, date)  Keplerian elements (Wikidata) -> geocentric RA/Dec
 *   parseEpoch(label)  "November 21, 2025" / "J2000" -> Julian date
 *   constellationCentre(englishName)
 *
 * Star catalogue, constellation lines and centres: d3-celestial (BSD-3-Clause).
 */
import Globe from 'globe.gl';
import * as Astronomy from 'astronomy-engine';
const DATA = 'https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/';
const MAX_SKY_ITEMS = 200;
const RING_LIFE = 4000;
// Teal / orange-red / purple: checked with a colour-vision validator against the page background,
// so additions, removals and new articles stay distinguishable with red-green colour blindness.
const COLORS = { add: [20, 166, 160], remove: [226, 96, 63], new: [154, 108, 240], neutral: [154, 163, 181] };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const rad = d => (d * Math.PI) / 180, deg = r => (r * 180) / Math.PI;
const mod360 = x => ((x % 360) + 360) % 360;
const raToLng = ra => { const l = -mod360(ra); return l < -180 ? l + 360 : l; };

// Star colour from B−V colour index (blue-white hot stars -> orange cool stars).
const BV_STOPS = [[-0.4, [155, 176, 255]], [0, [235, 240, 255]], [0.6, [255, 246, 234]], [1.0, [255, 221, 180]], [1.6, [255, 190, 130]]];
function starRGB(bv) {
  const x = Number.isFinite(+bv) ? +bv : 0.6;
  if (x <= BV_STOPS[0][0]) return BV_STOPS[0][1];
  for (let k = 1; k < BV_STOPS.length; k++) {
    const [x1, c1] = BV_STOPS[k];
    if (x <= x1) {
      const [x0, c0] = BV_STOPS[k - 1], t = (x - x0) / (x1 - x0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * t));
    }
  }
  return BV_STOPS[BV_STOPS.length - 1][1];
}

// Equirectangular star map (x = RA, y = Dec) from the same catalogue, used as the
// background behind the Earth globe so both views share one sky.
function paintStarfield(stars, lines) {
  const W = 4096, H = 2048;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#03050b';
  g.fillRect(0, 0, W, H);
  const X = ra => (mod360(ra) / 360) * W, Y = dec => ((90 - dec) / 180) * H;
  // faint constellation figures, as on the sky map
  g.strokeStyle = 'rgba(120,150,230,0.08)';
  g.lineWidth = 1;
  lines.features.forEach(f => f.geometry.coordinates.forEach(seg => {
    for (let k = 1; k < seg.length; k++) {
      const x0 = X(seg[k - 1][0]), x1 = X(seg[k][0]);
      if (Math.abs(x1 - x0) > W / 2) continue; // skip segments that wrap around RA 0h
      g.beginPath(); g.moveTo(x0, Y(seg[k - 1][1])); g.lineTo(x1, Y(seg[k][1])); g.stroke();
    }
  }));
  stars.features.forEach(f => {
    const [ra, dec] = f.geometry.coordinates, m = f.properties.mag;
    const x = X(ra), y = Y(dec);
    const stretch = 1 / Math.max(0.15, Math.cos(rad(dec))); // equirectangular widens near the poles
    const r = Math.max(0.45, (6.4 - m) * 0.36); // the background is shown ~1.5x magnified
    const [cr, cg, cb] = starRGB(f.properties.bv);
    const a = Math.min(1, Math.max(0.3, 1.15 - m / 6.5));
    if (m < 1.5) { // soft glow for the brightest stars only
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, `rgba(${cr},${cg},${cb},${a * 0.35})`);
      glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = glow;
      g.beginPath(); g.ellipse(x, y, r * 3 * stretch, r * 3, 0, 0, 2 * Math.PI); g.fill();
    }
    g.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
    g.beginPath(); g.ellipse(x, y, r * stretch, r, 0, 0, 2 * Math.PI); g.fill();
  });
  return c.toDataURL('image/png');
}

// ---------------- astronomy helpers ----------------
const PLANETS = { Q525: 'Sun', Q405: 'Moon', Q308: 'Mercury', Q313: 'Venus', Q111: 'Mars', Q319: 'Jupiter',
  Q193: 'Saturn', Q324: 'Uranus', Q332: 'Neptune', Q339: 'Pluto' };
let observer = null;
function planetPosition(qid, date) {
  const A = Astronomy;
  if (!PLANETS[qid]) return null;
  observer = observer || new A.Observer(0, 0, 0);
  const eq = A.Equator(A.Body[PLANETS[qid]], date, observer, false, true); // J2000 equator, with aberration
  return { ra: eq.ra * 15, dec: eq.dec };
}

const julian = date => date.getTime() / 86400000 + 2440587.5;
function parseEpoch(label) {
  if (!label) return null;
  if (/J2000/i.test(label)) return 2451545.0;
  let m = label.match(/^M?JD\s*([\d.]+)/i);
  if (m) return /^MJD/i.test(label) ? Number(m[1]) + 2400000.5 : Number(m[1]);
  const t = Date.parse(label + ' UTC');
  return Number.isFinite(t) ? t / 86400000 + 2440587.5 : null;
}

const OBLIQUITY = rad(23.4392911);
// Elements: a (AU), e, i, node (Ω), peri (ω), M (mean anomaly at epoch), all angles in degrees; epoch as JD.
function orbitPosition(o, date) {
  const A = Astronomy;
  if (!(o.e >= 0 && o.e < 1) || !(o.a > 0)) return null;
  const n = 0.9856076686 / Math.pow(o.a, 1.5); // mean motion, degrees/day
  const M = rad(mod360(o.M + n * (julian(date) - o.epoch)));
  let E = o.e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) E -= (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E));
  const xv = o.a * (Math.cos(E) - o.e), yv = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const N = rad(o.node), w = rad(o.peri), i = rad(o.i), u = v + w;
  // heliocentric ecliptic (J2000)
  const xh = r * (Math.cos(N) * Math.cos(u) - Math.sin(N) * Math.sin(u) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(u) + Math.cos(N) * Math.sin(u) * Math.cos(i));
  const zh = r * Math.sin(u) * Math.sin(i);
  // -> equatorial J2000, then make geocentric
  const xq = xh, yq = yh * Math.cos(OBLIQUITY) - zh * Math.sin(OBLIQUITY), zq = yh * Math.sin(OBLIQUITY) + zh * Math.cos(OBLIQUITY);
  const earth = A.HelioVector(A.Body.Earth, date);
  const gx = xq - earth.x, gy = yq - earth.y, gz = zq - earth.z;
  return { ra: mod360(deg(Math.atan2(gy, gx))), dec: deg(Math.asin(gz / Math.hypot(gx, gy, gz))) };
}

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s*\(constellation\)$/, '').trim();
const constellations = new Map(); // normalised English name -> { ra, dec, name }
function constellationCentre(name) { return constellations.get(norm(name)) || null; }

// ---------------- view ----------------
// Built by initSky(), which main.js calls at start-up.
let sky = null;
const items = [];
let rings = [];
let selected = null;
let onSelect = () => {};
let follow = false;
let rotate = true; // set from main.js (off with reduced motion)
let reduceMotion = false;
const glide = ms => (reduceMotion ? 0 : ms);
let lastFollow = 0;

// Resolves to the starfield image painted behind the Earth, once the star catalogue has loaded.
let resolveStarfield;
const starfield = new Promise(r => (resolveStarfield = r));

export function initSky() {
  const wrap = document.getElementById('sky-wrap');
  const el = document.getElementById('sky');
  sky = new Globe(el, { animateIn: false })
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor('#3a4f9a').atmosphereAltitude(0.08)
    .showGraticules(true)
    // stars
    .pointLat(d => d.dec).pointLng(d => raToLng(d.ra))
    .pointAltitude(0).pointRadius(d => Math.max(0.12, 0.62 - d.mag * 0.09))
    .pointColor(d => { const [r, g, b] = starRGB(d.bv); return `rgba(${r},${g},${b},${Math.max(0.3, 1 - d.mag / 6)})`; })
    .pointsMerge(true)
    // constellation figures
    .pathPoints('pts').pathPointLat(p => p[1]).pathPointLng(p => raToLng(p[0]))
    .pathColor(() => 'rgba(120,150,230,0.35)').pathStroke(null).pathPointAlt(0.001).pathTransitionDuration(0)
    // constellation names
    .labelLat('dec').labelLng(d => raToLng(d.ra)).labelText('name')
    .labelSize(1.6).labelDotRadius(0).labelColor(() => 'rgba(150,170,230,0.45)').labelResolution(2).labelAltitude(0.002)
    // edit ripples
    .ringLat('lat').ringLng('lng')
    .ringColor(d => t => rgba(COLORS[d.kind], (d.tier === 'exact' ? 0.9 : 0.45) * (1 - t)))
    .ringMaxRadius('maxR').ringPropagationSpeed('speed').ringRepeatPeriod(RING_LIFE * 2)
    // edit markers (HTML, clickable, any script)
    .htmlLat('lat').htmlLng('lng').htmlAltitude(0.003)
    .htmlElement(d => d.el)
    .htmlTransitionDuration(0);

  sky.globeMaterial().color.set('#070b1a');
  if (sky.globeMaterial().emissive) sky.globeMaterial().emissive.set('#05070f');
  if (typeof sky.htmlElementVisibilityModifier === 'function') {
    sky.htmlElementVisibilityModifier((elem, visible) => {
      elem.style.opacity = visible ? 1 : 0;
      elem.style.pointerEvents = visible ? 'auto' : 'none';
    });
  }
  sky.controls().autoRotate = true;
  sky.controls().autoRotateSpeed = 0.25;
  sky.controls().enableZoom = true;
  sky.pointOfView({ lat: 20, lng: 0, altitude: 2.3 });
  sky.controls().addEventListener('start', () => { dragging = true; });
  sky.controls().addEventListener('end', () => { dragging = false; });

  const resize = () => sky.width(el.clientWidth).height(el.clientHeight);
  new ResizeObserver(resize).observe(el);
  resize();

  document.getElementById('sky-expand').onclick = () => {
    const big = wrap.classList.toggle('big');
    document.getElementById('sky-expand').textContent = big ? '⤡' : '⤢';
    document.getElementById('sky-expand').setAttribute('aria-label', big ? 'Shrink sky map' : 'Enlarge sky map');
  };

  loadCatalogue();
  setInterval(() => {
    const n = rings.length;
    rings = rings.filter(r => Date.now() - r.born < RING_LIFE);
    if (n !== rings.length) sky.ringsData(rings.slice());
  }, 500);
}

// Stars, constellation lines and constellation centres.
function loadCatalogue() {
  Promise.all([
    fetch(DATA + 'stars.6.json').then(r => r.json()),
    fetch(DATA + 'constellations.lines.json').then(r => r.json()),
    fetch(DATA + 'constellations.json').then(r => r.json()),
  ]).then(([stars, lines, cons]) => {
    sky.pointsData(stars.features.filter(f => f.properties.mag < 5)
      .map(f => ({ ra: f.geometry.coordinates[0], dec: f.geometry.coordinates[1], mag: f.properties.mag, bv: f.properties.bv })));
    resolveStarfield(paintStarfield(stars, lines));
    const paths = [];
    lines.features.forEach(f => f.geometry.coordinates.forEach(seg => paths.push({ pts: seg })));
    sky.pathsData(paths);
    const labels = [];
    cons.features.forEach(f => {
      const [ra, dec] = f.geometry.coordinates;
      // Latin IAU names ("Leo", "Ursa Major"); the label font is Latin-only, so normalise unusual spaces.
      const entry = { ra: mod360(ra), dec, name: (f.properties.name || f.properties.en).replace(/\s+/g, ' ') };
      labels.push(entry);
      constellations.set(norm(f.properties.en), entry);
      constellations.set(norm(f.properties.name), entry);
      constellations.set(norm(f.properties.la), entry);
    });
    sky.labelsData(labels);
  }).catch(err => console.warn('sky catalogue failed to load', err));
}

// Re-send ripples and markers after an edit is added. (Re-sending markers re-attaches their elements, which
// can swallow a click in progress, so it happens only then.)
function refresh() {
  const now = Date.now();
  rings = rings.filter(r => now - r.born < RING_LIFE);
  sky.ringsData(rings.slice());
  sky.htmlElementsData(items.slice());
  document.getElementById('sky-empty').hidden = items.length > 0;
  document.getElementById('sky-count').textContent = items.length ? (items.length === 1 ? '1 edit' : items.length + ' edits') : '';
}
function ripple(item) {
  if (reduceMotion) return;
  const size = Math.log10(Math.abs(item.delta) + 10);
  const exact = item.tier === 'exact';
  rings.push({ lat: item.lat, lng: item.lng, kind: item.kind, tier: item.tier, born: Date.now(),
    maxR: exact ? 2 + size * 1.2 : 7 + size, speed: exact ? 3 + size : 2 });
}

// A new edit on the sky map: a clickable marker whose title shows for a few seconds, a ripple, and Follow.
// quiet: added without the ripple, title or Follow (an edit placed long after it was made, or a hidden tab).
function add(item, { quiet = false } = {}) {
  const m = document.createElement('div');
  m.className = 'skym' + (item.tier === 'exact' ? '' : ' approx');
  m.style.setProperty('--c', rgba(COLORS[item.kind], 1));
  const dot = document.createElement('i');
  const label = document.createElement('span');
  label.textContent = m.title = item.title;
  m.append(dot, label);
  m.addEventListener('pointerdown', e => { e.stopPropagation(); onSelect(item); });
  item.el = m;

  items.push(item);
  items.sort((a, b) => a.time - b.time);
  if (items.length > MAX_SKY_ITEMS) items.shift();
  if (!quiet) {
    m.classList.add('fresh');
    setTimeout(() => m.classList.remove('fresh'), 6000);
    ripple(item);
  }
  refresh();
  if (!quiet && follow) followTo(item);
}

// Follow: centre on the newest edit (at most every 1.5 s, so bursts don't jerk the camera around).
// Holds still while an edit is open and while the mouse is over the sky map or dragging it.
let followTimer = null, followNext = null;
function followTo(item) {
  if (selected || hovering || dragging) return;
  followNext = item;
  const wait = lastFollow + 1500 - Date.now();
  if (wait > 0) {
    if (!followTimer) followTimer = setTimeout(() => { followTimer = null; if (follow) followTo(followNext); }, wait);
    return;
  }
  lastFollow = Date.now();
  if (!followed) { followed = true; applyRotation(); }
  sky.pointOfView({ lat: item.lat, lng: item.lng, altitude: sky.pointOfView().altitude }, glide(1000));
}
// Rotation pauses while following (once there's an edit to follow), while an edit is open, and while the mouse is over the sphere or a
// marker (main.js wires that up with watchHover() from globe.js).
let hovering = false, dragging = false, followed = false;
function setHovering(on) { hovering = on; applyRotation(); }
function applyRotation() { sky.controls().autoRotate = rotate && !(follow && followed) && !selected && !hovering; }
function setFollow(on) {
  follow = on;
  applyRotation();
  if (on && items.length) { lastFollow = 0; followTo(items[items.length - 1]); }
}
function setRotate(on) { rotate = on; applyRotation(); }

function focus(item) {
  if (selected && selected.el) selected.el.classList.remove('sel');
  selected = item;
  if (item && item.el) item.el.classList.add('sel');
  if (item) {
    sky.pointOfView({ lat: item.lat, lng: item.lng, altitude: Math.min(sky.pointOfView().altitude, 1.8) }, glide(900));
  }
  applyRotation();
}

export const WikiSky = {
  planetPosition, orbitPosition, parseEpoch, constellationCentre, raToLng,
  setReducedMotion(on) { reduceMotion = !!on; if (on) rings = []; },
  add, focus, setFollow, setRotate, setHovering, starfield,
  set onSelect(fn) { onSelect = fn; },
  get globe() { return sky; },
};

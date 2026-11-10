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
(function () {
  const DATA = 'https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/';
  const MAX_SKY_ITEMS = 200;
  const RING_LIFE = 4000;
  const COLORS = { add: [61, 220, 151], remove: [255, 107, 107], new: [178, 141, 255], neutral: [154, 163, 181] };
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
    const A = window.Astronomy;
    if (!A || !PLANETS[qid]) return null;
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
    const A = window.Astronomy;
    if (!A || !(o.e >= 0 && o.e < 1) || !(o.a > 0)) return null;
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
  const wrap = document.getElementById('sky-wrap');
  const el = document.getElementById('sky');
  const items = [];
  let rings = [];
  let selected = null;
  let onSelect = () => {};
  let follow = false;
  let rotate = true;
  let lastFollow = 0;

  const sky = new Globe(el, { animateIn: false })
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

  const resize = () => sky.width(el.clientWidth).height(el.clientHeight);
  new ResizeObserver(resize).observe(el);
  resize();

  document.getElementById('sky-expand').onclick = () => {
    const big = wrap.classList.toggle('big');
    document.getElementById('sky-expand').textContent = big ? '⤡' : '⤢';
    document.getElementById('sky-expand').setAttribute('aria-label', big ? 'Shrink sky map' : 'Enlarge sky map');
  };

  // Load catalogue data (stars, constellation lines and centres).
  let resolveStarfield;
  const starfield = new Promise(r => (resolveStarfield = r));
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

  // Timeline: with a cutoff set, only edits made up to that moment are shown.
  let cutoff = null, shownKey = '';
  const shownItems = () => (cutoff == null ? items : items.filter(it => it.time <= cutoff));
  function refresh() {
    const now = Date.now();
    rings = rings.filter(r => now - r.born < RING_LIFE);
    sky.ringsData(rings.slice());
    const shown = shownItems();
    // Re-send markers only when the visible set changes: re-sending re-attaches their elements.
    const key = shown.length + ':' + (shown.length ? shown[shown.length - 1].id : '') + ':' + items.length;
    if (key !== shownKey) { shownKey = key; sky.htmlElementsData(shown.slice()); }
    const n = shown.length;
    document.getElementById('sky-empty').hidden = n > 0;
    document.getElementById('sky-count').textContent = n ? (n === 1 ? '1 edit' : n + ' edits') : '';
  }
  function setCutoff(t) {
    if (t === cutoff) return;
    cutoff = t;
    refresh();
  }
  function ripple(item) {
    const size = Math.log10(Math.abs(item.delta) + 10);
    const exact = item.tier === 'exact';
    rings.push({ lat: item.lat, lng: item.lng, kind: item.kind, tier: item.tier, born: Date.now(),
      maxR: exact ? 2 + size * 1.2 : 7 + size, speed: exact ? 3 + size : 2 });
  }
  // The playhead passed this edit: ripple, show its title briefly, and Follow.
  function pulse(item) {
    ripple(item);
    if (item.el) {
      item.el.classList.add('fresh');
      clearTimeout(item.el._fresh);
      item.el._fresh = setTimeout(() => item.el.classList.remove('fresh'), 6000);
    }
    refresh();
    if (follow && !selected) followTo(item);
  }
  setInterval(() => { const n = rings.length; rings = rings.filter(r => Date.now() - r.born < RING_LIFE); if (n !== rings.length) sky.ringsData(rings.slice()); }, 500);

  // quiet: recorded while the timeline is replaying the past, so no ripple or Follow now.
  function add(item, { quiet = false } = {}) {
    const exact = item.tier === 'exact';
    const m = document.createElement('div');
    m.className = 'skym' + (exact ? '' : ' approx') + ' fresh';
    m.style.setProperty('--c', rgba(COLORS[item.kind], 1));
    const dot = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = item.title;
    m.append(dot, label);
    m.title = item.title;
    m.addEventListener('pointerdown', e => { e.stopPropagation(); onSelect(item); });
    if (quiet) m.classList.remove('fresh');
    else m._fresh = setTimeout(() => m.classList.remove('fresh'), 6000);
    item.el = m;

    items.push(item);
    items.sort((a, b) => a.time - b.time);
    if (items.length > MAX_SKY_ITEMS) items.shift();
    if (!quiet) ripple(item);
    refresh();
    if (!quiet && follow && !selected) followTo(item);
  }

  // Follow: centre on the newest edit (at most every 1.5 s, so bursts don't jerk the camera around).
  let followTimer = null, followNext = null;
  function followTo(item) {
    followNext = item;
    const wait = lastFollow + 1500 - Date.now();
    if (wait > 0) {
      if (!followTimer) followTimer = setTimeout(() => { followTimer = null; if (follow && !selected) followTo(followNext); }, wait);
      return;
    }
    lastFollow = Date.now();
    sky.pointOfView({ lat: item.lat, lng: item.lng, altitude: sky.pointOfView().altitude }, 1000);
  }
  function applyRotation() { sky.controls().autoRotate = rotate && !follow && !selected; }
  function setFollow(on) {
    follow = on;
    applyRotation();
    if (on && !selected && items.length) { lastFollow = 0; followTo(items[items.length - 1]); }
  }
  function setRotate(on) { rotate = on; applyRotation(); }

  function focus(item) {
    if (selected && selected.el) selected.el.classList.remove('sel');
    selected = item;
    if (item && item.el) item.el.classList.add('sel');
    if (item) {
      sky.pointOfView({ lat: item.lat, lng: item.lng, altitude: Math.min(sky.pointOfView().altitude, 1.8) }, 900);
    }
    applyRotation();
  }

  window.WikiSky = {
    planetPosition, orbitPosition, parseEpoch, constellationCentre, raToLng,
    add, pulse, setCutoff, focus, setFollow, setRotate, starfield,
    set onSelect(fn) { onSelect = fn; },
    globe: sky,
  };
})();

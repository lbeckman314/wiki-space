(function () {
  const STREAM = 'https://stream.wikimedia.org/v2/stream/recentchange';
  const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/';
  const TOP_WIKIS = new Set(['en', 'de', 'fr', 'es', 'ja', 'ru', 'it', 'zh', 'pt', 'ar', 'pl', 'nl', 'fa', 'uk', 'he', 'sv', 'ko', 'tr', 'id', 'vi']);

  const MAX_POINTS = 400;       // persistent dots
  const POINT_LIFE = 10 * 60e3; // dots fade out over 10 minutes
  const RING_LIFE = 3000;
  const LABEL_LIFE = 6000;
  const MAX_LABELS = 6;
  const MAX_TICKER = 60;
  const MAX_UNPLACED = 5000;    // unplaced edits kept for the Unplaced tab and search
  const MAX_HISTORY = 50000;    // placed edits kept in memory for the timeline

  const COLORS = { add: [61, 220, 151], remove: [255, 107, 107], new: [178, 141, 255], neutral: [154, 163, 181] };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const pad = n => String(n).padStart(2, '0');
  function fmtRA(ra) { const h = ((ra % 360) + 360) % 360 / 15; const m = (h % 1) * 60; return `${Math.floor(h)}h ${pad(Math.floor(m))}m ${pad(Math.round((m % 1) * 60) % 60)}s`; }
  function fmtDec(dec) { const a = Math.abs(dec); const m = (a % 1) * 60; return `${dec < 0 ? '−' : '+'}${Math.floor(a)}° ${pad(Math.floor(m))}′`; }
  const fmtDelta = d => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toLocaleString();

  const state = {
    mode: $('wiki-mode').value,
    showApprox: true,
    pointStyle: 'markers', // or 'heatmap'
    follow: false,
    rotate: true,
    paused: false,
    sound: false,
    unplacedList: [], // edits that could not be placed, oldest first
    history: [],  // every placed edit (Earth and sky) this session, ordered by edit time
    points: [],   // Earth edits on screen: the POINT_LIFE window before the playhead, oldest first
    groups: [],   // points merged into on-screen clusters (see buildGroups)
    rings: [],
    labels: [],
    selected: null,
    // stats
    considered: [], // timestamps of accepted article edits (for per-minute rate)
    resolved: 0, placed: 0, exact: 0, approx: 0, sky: 0, offworld: 0, unplaced: 0,
  };

  // ---------------- globe ----------------
  const wrap = $('globe');
  const world = new Globe(wrap, { animateIn: true })
    .globeImageUrl(TEX + 'earth-night.jpg')
    .bumpImageUrl(TEX + 'earth-topology.png')
    .showAtmosphere(true).atmosphereColor('#5b8cff').atmosphereAltitude(0.17)
    // persistent markers: one flat disc per cluster of nearby edits (see buildGroups)
    .pointLat('lat').pointLng('lng')
    .pointAltitude(0.0015) // flat discs, so they don't turn into columns when seen from close up
    .pointRadius(markerRadius)
    .pointColor(g => {
      const age = (clockNow() - g.latest.time) / POINT_LIFE;
      const sel = g.items.includes(state.selected);
      return rgba(sel ? [255, 255, 255] : COLORS[g.latest.kind], sel ? 0.95 : Math.max(0.12, (g.exact ? 0.95 : 0.45) * (1 - age)));
    })
    .pointResolution(24)
    .pointsMerge(false)
    .pointsTransitionDuration(0)
    .pointLabel(groupTooltip)
    .onPointClick(g => select(g.latest))
    // edit counts on clusters
    .labelLat(g => g.lat - 0.8 * markerRadius(g)).labelLng('lng').labelText(g => String(g.n)) // shifted so the number sits centred on the disc
    .labelSize(g => markerRadius(g) * 1.05).labelDotRadius(0).labelAltitude(0.003).labelResolution(2)
    .labelColor(g => (g.items.includes(state.selected) ? 'rgba(10,14,25,0.95)' : 'rgba(255,255,255,0.95)'))
    .labelDotOrientation(() => 'top')
    .labelLabel(groupTooltip)
    .onLabelClick(g => select(g.latest))
    // heatmap (the alternative point style): one dataset, thin and close to the surface
    .heatmapPoints('points').heatmapPointLat('lat').heatmapPointLng('lng')
    .heatmapPointWeight('w') // summed edit weights of one cluster (see scheduleHeatmap)
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

  // Hide (and make unclickable) labels that are on the far side of the Earth.
  if (typeof world.htmlElementVisibilityModifier === 'function') {
    world.htmlElementVisibilityModifier((elem, visible) => {
      elem.style.visibility = visible ? 'visible' : 'hidden';
    });
  }
  // Same star catalogue as the sky map, painted as the background sphere.
  WikiSky.starfield.then(url => world.backgroundImageUrl(url));

  world.controls().autoRotate = true;
  world.controls().autoRotateSpeed = 0.35;
  world.pointOfView({ lat: 25, lng: 10, altitude: 2.4 });

  function resize() { world.width(wrap.clientWidth).height(wrap.clientHeight); }
  new ResizeObserver(resize).observe(wrap);
  resize();

  // ---------------- stream ----------------
  let es = null;
  function setStatus(kind, text) {
    $('status-dot').className = 'dot ' + kind;
    $('status-text').textContent = text;
  }
  function connect() {
    if (es) es.close();
    setStatus('', 'connecting…');
    es = new EventSource(STREAM);
    es.onopen = () => setStatus('live', 'live from Wikipedia');
    es.onerror = () => setStatus('down', 'reconnecting…'); // EventSource retries on its own
    es.onmessage = onEvent;
  }
  function disconnect() { if (es) es.close(); es = null; setStatus('down', 'paused'); }

  function accept(d) {
    if (d.bot || d.namespace !== 0) return false;
    if (d.type !== 'edit' && d.type !== 'new') return false;
    if (!d.server_name || !d.server_name.endsWith('.wikipedia.org')) return false;
    const lang = d.server_name.split('.')[0];
    if (state.mode === 'en') return lang === 'en';
    if (state.mode === 'top') return TOP_WIKIS.has(lang);
    return true;
  }

  function onEvent(e) {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!accept(d)) return;
    handle(d);
  }

  function handle(d) {
    const lang = d.server_name.split('.')[0];
    state.considered.push(Date.now());
    WikiGeo.resolveLocation(d.server_name, d.title, lang).then(loc => {
      state.resolved++;
      if (!loc) return unplaced(d, lang, 'No coordinates, and no related place on Wikidata');
      if (loc.offworld) {
        state.offworld++;
        const body = String(loc.offworld);
        return unplaced(d, lang, `On the surface of ${body.charAt(0).toUpperCase() + body.slice(1)}`);
      }
      place(d, lang, loc);
    });
  }

  // ---------------- placing an edit ----------------
  let seq = 0;
  function makeItem(d, lang) {
    const oldLen = (d.length && d.length.old) || 0;
    const newLen = (d.length && d.length.new) || 0;
    const delta = newLen - oldLen;
    const kind = d.type === 'new' ? 'new' : delta > 0 ? 'add' : delta < 0 ? 'remove' : 'neutral';
    // When the edit was made (not when its location was found), so the timeline replays in true order.
    const made = (d.meta && Date.parse(d.meta.dt)) || (d.timestamp && d.timestamp * 1000) || Date.now();
    return {
      id: ++seq, time: Math.min(made, Date.now()), kind, delta, lang,
      title: d.title, server: d.server_name, user: d.user, comment: d.comment, simulated: !!d.simulated,
      revOld: d.revision && d.revision.old, revNew: d.revision && d.revision.new,
    };
  }

  function unplaced(d, lang, reason) {
    const item = { ...makeItem(d, lang), unplaced: true, reason };
    state.unplaced++;
    state.unplacedList.push(item);
    if (state.unplacedList.length > MAX_UNPLACED) state.unplacedList.shift();
    listDirty = true;
  }

  function place(d, lang, loc) {
    const base = { ...makeItem(d, lang), tier: loc.tier, reason: loc.reason, qid: loc.qid };
    state.placed++;

    if (loc.sky) {
      const item = { ...base, sky: true, ra: loc.ra, dec: loc.dec, distance: loc.distance,
        lat: loc.dec, lng: WikiSky.raToLng(loc.ra) };
      state.sky++;
      record(item);
      WikiSky.add(item, { quiet: !tl.live }); // while replaying, it appears when the playhead reaches it
      addTicker(item);
      if (tl.live && state.sound) WikiSound.play(item);
      return;
    }

    // Approximate edits sit exactly on their place; nearby edits are merged into one marker (buildGroups).
    const item = { ...base, lat: loc.lat, lng: loc.lng };
    loc.tier === 'exact' ? state.exact++ : state.approx++;
    record(item);
    addTicker(item);
    if (tl.live && (item.tier === 'exact' || state.showApprox)) announce(item);
  }

  // ---------------- history (for the timeline) ----------------
  // First index whose edit time is after t.
  function upperBound(t) {
    const h = state.history;
    let lo = 0, hi = h.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid].time <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function record(item) {
    state.history.splice(upperBound(item.time), 0, item); // lookups finish out of order, so insert sorted
    if (state.history.length > MAX_HISTORY) state.history.shift();
    windowDirty = true;
    histDirty = true;
  }
  // Earth edits shown at the playhead: the POINT_LIFE before it (plus the selected edit, wherever it is).
  function computeWindow() {
    const T = clockNow();
    const out = [];
    for (let i = upperBound(T - POINT_LIFE); i < state.history.length && state.history[i].time <= T; i++) {
      if (!state.history[i].sky) out.push(state.history[i]);
    }
    const sel = state.selected;
    if (sel && !sel.sky && !sel.unplaced && !out.includes(sel)) sel.time < T ? out.unshift(sel) : out.push(sel);
    state.points = out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;
    windowDirty = false;
  }

  // Ripple, floating title, sound and Follow for one edit: on arrival when live, or when the playhead passes it.
  function announce(item, { label = true, sound = true } = {}) {
    if (item.sky) {
      WikiSky.pulse(item);
      if (sound && state.sound) WikiSound.play(item);
      return;
    }
    const size = Math.log10(Math.abs(item.delta) + 10); // 1 .. ~5
    const exact = item.tier === 'exact';
    state.rings.push({
      lat: item.lat, lng: item.lng, kind: item.kind, tier: item.tier, born: Date.now(),
      maxR: exact ? 1 + size * 1.1 : item.tier === 'country' ? 5 + size : 2.5 + size,
      speed: exact ? 2.5 + size : 1.4,
    });
    dirty = true;
    if (sound && state.sound) WikiSound.play(item);
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
    labelsDirty = true;
  }

  // Follow: centre the Earth on the newest edit (at most every 1.5 s).
  // If edits arrive faster than that, the camera catches up with the latest one when the wait is over.
  let lastFollow = 0, followTimer = null, followNext = null;
  function followTo(item) {
    followNext = item;
    const wait = lastFollow + 1500 - Date.now();
    if (wait > 0) {
      if (!followTimer) followTimer = setTimeout(() => { followTimer = null; if (state.follow && !state.selected) followTo(followNext); }, wait);
      return;
    }
    lastFollow = Date.now();
    world.pointOfView({ lat: item.lat, lng: item.lng, altitude: world.pointOfView().altitude }, 1000);
  }
  function applyRotation() { world.controls().autoRotate = state.rotate && !state.follow && !state.selected; }

  // ---------------- clustering ----------------
  // Edits are merged into one marker when they fall in the same grid cell. The cell size follows the
  // camera altitude, so clusters split apart as you zoom in. Exact and approximate edits never merge
  // with each other; approximate edits share their place's coordinates, so each place becomes one marker.
  let clusterAlt = 2.4;
  // Marker radius in degrees. It scales with camera altitude, so a marker keeps roughly the same size
  // on screen at any zoom, and grows with the number of edits it holds.
  function markerRadius(g) {
    const base = (g.exact ? 0.28 : 0.32) * clusterAlt;
    return base * Math.min(3, 1 + 0.35 * Math.sqrt(g.n - 1)) * (g.items.includes(state.selected) ? 1.25 : 1);
  }
  const cellSize = alt => Math.min(5, Math.max(0.01, alt * 0.7)); // wider than a marker, so neighbours rarely overlap
  function buildGroups() {
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
    } else {
      world.pointsData(state.groups).labelsData(state.groups.filter(g => g.n > 1));
    }
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
  const heatBandwidth = () => (clusterAlt > 1.6 ? 4 : clusterAlt > 0.7 ? 3 : 2);
  // Colour scale (same stops as the legend): blue → cyan → green → amber → red, never fully opaque,
  // so the globe stays visible under the heat.
  const HEAT_STOPS = [[0, [70, 134, 251]], [0.3, [26, 228, 182]], [0.55, [162, 252, 60]], [0.78, [250, 187, 57]], [1, [228, 70, 10]]];
  function heatColor(t) {
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
  function setPointStyle(style) {
    state.pointStyle = style === 'heatmap' ? 'heatmap' : 'markers';
    document.body.classList.toggle('points-heatmap', state.pointStyle === 'heatmap');
    $('point-style').value = state.pointStyle;
    if (state.pointStyle !== 'heatmap') world.heatmapsData([]);
    heatSig = '';
    buildGroups();
    if (state.pointStyle === 'heatmap') scheduleHeatmap(true);
    try { localStorage.setItem('wikiGlobe.pointStyle', state.pointStyle); } catch (e) { /* not saved */ }
  }
  // The heatmap has no click events, so a click (not a drag) on the Earth in heatmap mode opens the
  // newest edit near that spot.
  let downAt = null;
  wrap.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  wrap.addEventListener('click', e => {
    if (state.pointStyle !== 'heatmap' || !downAt) return;
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
  function greatCircleDeg(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / r;
  }
  const groupOf = item => state.groups.find(g => g.items.includes(item));

  function groupTooltip(g) {
    if (g.n === 1) {
      const d = g.latest;
      return `<div class="tip"><b>${esc(d.title)}</b><span>${esc(d.lang)}.wikipedia · ${fmtDelta(d.delta)} · ${esc(d.reason)}</span></div>`;
    }
    const recent = g.items.slice(-6).reverse().map(d => `<li>${esc(d.title)} <span>${esc(d.lang)}</span></li>`).join('');
    const where = g.exact ? 'nearby' : esc(g.latest.reason);
    return `<div class="tip"><b>${g.n} edits · ${where}</b><ul>${recent}</ul>${g.n > 6 ? `<span>+${g.n - 6} more · click to see all</span>` : '<span>click to open</span>'}</div>`;
  }

  // Batch globe updates to at most a few per second.
  let dirty = false, labelsDirty = false, windowDirty = false, histDirty = false, lastWindow = 0;
  setInterval(() => {
    const now = Date.now();
    const ringsBefore = state.rings.length;
    state.rings = state.rings.filter(r => now - r.born < RING_LIFE);
    state.labels.forEach(l => { l.el.classList.toggle('fading', now - l.born > LABEL_LIFE - 800); });
    // Recompute the on-screen window when edits arrive, the playhead moves, or (live) once a second for expiry.
    let rebuild = false;
    if (windowDirty || (tl.live && now - lastWindow > 1000)) { computeWindow(); lastWindow = now; rebuild = true; }
    // Re-cluster when the window changed, or when the zoom has changed noticeably.
    const alt = world.pointOfView().altitude;
    if (rebuild || dirty || Math.abs(alt - clusterAlt) / clusterAlt > 0.12) buildGroups();
    // Labels are re-sent only when one is added: re-sending re-attaches their elements.
    if (dirty || ringsBefore !== state.rings.length) world.ringsData(state.rings.slice());
    if (labelsDirty) world.htmlElementsData(state.labels.slice());
    labelsDirty = false;
    dirty = false;
  }, 250);
  // Re-colour markers for fading every few seconds.
  setInterval(buildGroups, 5000);

  const visiblePoints = () => (state.showApprox ? state.points.slice() : state.points.filter(p => p.tier === 'exact'));

  // ---------------- sidebar list: tabs, filters and search ----------------
  // The list is rebuilt from the data (state.history / state.unplacedList), newest first, so search and
  // filters cover everything recorded this session. Only the first MAX_TICKER matches are drawn.
  const list = { tab: 'placed', filter: 'all', q: '', shown: [] };
  let listDirty = true;
  function addTicker() { listDirty = true; }
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const FILTERS = {
    all: () => true,
    exact: it => !it.sky && it.tier === 'exact',
    approx: it => !it.sky && it.tier !== 'exact',
    sky: it => !!it.sky,
  };
  const FILTER_NAMES = { all: 'placed', exact: 'exact', approx: 'approximate', sky: 'sky' };
  function renderList() {
    listDirty = false;
    const source = list.tab === 'placed' ? state.history : state.unplacedList;
    const pass = list.tab === 'placed' ? FILTERS[list.filter] : FILTERS.all;
    const terms = fold(list.q).split(/\s+/).filter(Boolean);
    const shown = [];
    let matches = 0;
    for (let i = source.length - 1; i >= 0; i--) {
      const it = source[i];
      if (!pass(it)) continue;
      if (terms.length) {
        const hay = it._hay || (it._hay = fold(`${it.title} ${it.lang} ${it.reason} ${it.user}`));
        if (!terms.every(t => hay.includes(t))) continue;
      }
      matches++;
      if (shown.length < MAX_TICKER) shown.push(it);
    }
    list.shown = shown;
    $('ticker').innerHTML = shown.map((item, i) => {
      const cls = item.kind === 'new' ? 'newc' : item.delta > 0 ? 'pos' : item.delta < 0 ? 'neg' : '';
      const icon = item.unplaced ? '∅' : item.sky ? '✦' : item.tier === 'exact' ? '📍' : '≈';
      const sel = item === state.selected ? ' class="sel"' : '';
      return `<li data-i="${i}"${sel}><i class="sw" style="--c:${rgba(COLORS[item.kind], 1)};${item.tier === 'exact' || item.sky ? '' : 'opacity:.55'}"></i>` +
        `<span class="t">${esc(item.title)}<span class="sub">${esc(item.lang)} · ${icon} ${esc(item.reason)}</span></span>` +
        `<span class="d ${cls}">${item.kind === 'new' ? 'new' : fmtDelta(item.delta)}</span></li>`;
    }).join('');
    const total = list.tab === 'placed' ? state.history.length : state.unplacedList.length;
    const kindName = list.tab === 'placed' ? FILTER_NAMES[list.filter] : 'unplaced';
    const what = `${kindName} edit${matches === 1 ? '' : 's'}`;
    let note;
    if (!total) note = list.tab === 'placed' ? 'No placed edits yet.' : 'No unplaced edits yet.';
    else if (!matches) note = `No ${what} match “${esc(list.q.trim())}”.`;
    else if (terms.length || list.filter !== 'all') note = `${matches.toLocaleString()} ${what}${terms.length ? ` matching “${esc(list.q.trim())}”` : ''}${matches > shown.length ? ` · newest ${shown.length} shown` : ''}`;
    else note = matches > shown.length ? `Newest ${shown.length} of ${matches.toLocaleString()} · search to find older ones` : '';
    $('list-note').innerHTML = note;
    $('list-note').hidden = !note;
  }
  // One click handler for all rows (rows are rebuilt often).
  $('ticker').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) select(list.shown[Number(li.dataset.i)]);
  });
  setInterval(() => { if (listDirty) renderList(); }, 400);

  function showTab(name) {
    list.tab = name;
    for (const t of ['placed', 'unplaced']) $('tab-' + t).setAttribute('aria-selected', String(t === name));
    $('filters').hidden = name !== 'placed';
    renderList();
  }
  function setFilter(name) {
    list.filter = name;
    for (const b of $('filters').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === name));
    renderList();
  }
  $('tab-placed').onclick = () => showTab('placed');
  $('tab-unplaced').onclick = () => showTab('unplaced');
  $('filters').addEventListener('click', e => { const b = e.target.closest('button[data-filter]'); if (b) setFilter(b.dataset.filter); });
  let searchTimer = null;
  $('search').addEventListener('input', e => {
    list.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 120);
  });
  $('search').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; list.q = ''; renderList(); } });

  // Stats in the top bar open the sidebar with the matching filter.
  document.querySelectorAll('#stats button[data-filter]').forEach(b => {
    b.onclick = () => {
      setView('sidebar', true);
      showTab('placed');
      setFilter(b.dataset.filter);
      $('ticker').scrollTop = 0;
    };
  });

  // ---------------- show / hide panels ----------------
  // Remembered per browser; storage can be unavailable (private mode, blocked), so every access is guarded.
  const VIEW_KEY = 'wikiGlobe.view';
  const view = { sidebar: true, sky: true, timeline: true };
  try { Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch (e) { /* defaults */ }
  function setView(part, on) {
    view[part] = on;
    document.body.classList.toggle('hide-' + part, !on);
    $('v-' + part).setAttribute('aria-pressed', String(on));
    if (part === 'sky') on ? WikiSky.globe.resumeAnimation() : WikiSky.globe.pauseAnimation(); // no drawing while hidden
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (e) { /* not saved */ }
  }
  for (const part of Object.keys(view)) {
    $('v-' + part).onclick = () => setView(part, !view[part]);
    setView(part, view[part]);
  }

  // ---------------- detail card ----------------
  function select(item) {
    state.selected = item;
    listDirty = true; // highlight it in the list
    if (!view.sidebar) setView('sidebar', true); // the card lives in the sidebar
    if (item.sky) {
      WikiSky.focus(item);
    } else if (item.unplaced) {
      WikiSky.focus(null);
    } else {
      WikiSky.focus(null);
      computeWindow(); // includes the selected edit even if it is outside the current window
      buildGroups();
      applyRotation();
      world.pointOfView({ lat: item.lat, lng: item.lng, altitude: Math.min(world.pointOfView().altitude, 1.6) }, 900);
    }
    renderAlsoHere(item);

    const base = `https://${item.server}`;
    const path = encodeURIComponent(item.title.replace(/ /g, '_'));
    $('card').hidden = false;
    $('card-lang').textContent = item.lang;
    $('card-time').textContent = new Date(item.time).toLocaleTimeString();
    $('card-title').textContent = item.title;
    $('card-title').href = `${base}/wiki/${path}`;
    const exact = item.tier === 'exact';
    $('card-where').innerHTML = (item.unplaced
      ? `∅ <b>Not placed</b> · ${esc(item.reason)}`
      : item.sky
      ? `✦ <b>${exact ? 'Sky' : 'Sky, approximate'}</b> · RA ${fmtRA(item.ra)}, Dec ${fmtDec(item.dec)} · ${esc(item.reason)}` +
        (item.distance ? ` · ${esc(item.distance)}` : '')
      : (exact ? '📍 <b>Exact</b> · ' : '≈ <b>Approximate</b> · ') + esc(item.reason)) +
      (item.qid ? ` · <a href="https://www.wikidata.org/wiki/${esc(item.qid)}" target="_blank" rel="noopener">${esc(item.qid)}</a>` : '');
    const cls = item.kind === 'new' ? 'newc' : item.delta > 0 ? 'pos' : item.delta < 0 ? 'neg' : '';
    $('card-delta').innerHTML = `<span class="${cls}">${item.kind === 'new' ? 'New article, ' : ''}${fmtDelta(item.delta)} bytes</span>`;
    $('card-user').textContent = item.user;
    $('card-user').href = `${base}/wiki/Special:Contributions/${encodeURIComponent(item.user)}`;
    $('card-comment').textContent = item.comment || '—';
    $('card-diff').href = item.revOld ? `${base}/w/index.php?diff=${item.revNew}&oldid=${item.revOld}` : `${base}/w/index.php?oldid=${item.revNew}`;
    $('card-diff').textContent = item.revOld ? 'View diff ↗' : 'View page revision ↗';
    $('card-diff').hidden = item.simulated;
    $('card-extract').textContent = '';
    $('card-thumb').hidden = true;

    fetch(`${base}/api/rest_v1/page/summary/${path}`)
      .then(r => (r.ok ? r.json() : null))
      .then(s => {
        if (!s || state.selected !== item) return;
        $('card-extract').textContent = s.extract || '';
        if (s.thumbnail && s.thumbnail.source) { $('card-thumb').src = s.thumbnail.source; $('card-thumb').hidden = false; }
      })
      .catch(() => {});
  }
  // Other edits in the same marker, listed under the card.
  function renderAlsoHere(item) {
    const box = $('card-more');
    const g = !item.sky && !item.unplaced && groupOf(item);
    const others = g ? g.items.filter(p => p !== item).reverse() : [];
    box.hidden = !others.length;
    if (!others.length) return;
    box.innerHTML = `<h4>${others.length} more edit${others.length > 1 ? 's' : ''} ${g.exact ? 'nearby' : 'at this place'}</h4><ol></ol>`;
    const ol = box.querySelector('ol');
    others.slice(0, 30).forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<i class="sw" style="--c:${rgba(COLORS[p.kind], 1)}"></i><span class="t">${esc(p.title)}</span>` +
        `<span class="sub">${esc(p.lang)} · ${new Date(p.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
      li.onclick = () => select(p);
      ol.appendChild(li);
    });
    if (others.length > 30) ol.insertAdjacentHTML('beforeend', `<li class="more">+${others.length - 30} more</li>`);
  }

  $('card-close').onclick = () => {
    $('card').hidden = true;
    state.selected = null;
    listDirty = true;
    WikiSky.focus(null);
    computeWindow();
    buildGroups();
    applyRotation();
  };

  // ---------------- stats ----------------
  setInterval(() => {
    const cutoff = Date.now() - 60e3;
    while (state.considered.length && state.considered[0] < cutoff) state.considered.shift();
    $('s-rate').textContent = state.considered.length.toLocaleString();
    $('s-placed').textContent = state.resolved ? Math.round((100 * state.placed) / state.resolved) + '%' : '–';
    $('s-exact').textContent = state.exact.toLocaleString();
    $('s-approx').textContent = state.approx.toLocaleString();
    $('s-sky').textContent = state.sky.toLocaleString();
    $('n-placed').textContent = state.placed.toLocaleString();
    $('n-unplaced').textContent = state.unplaced.toLocaleString();
    if (es && es.readyState === EventSource.OPEN) {
      WikiGeo.cooldownMs > 0 ? setStatus('', 'live · lookups rate-limited, slowing down') : setStatus('live', 'live from Wikipedia');
    }
  }, 1000);

  // ---------------- timeline ----------------
  // Everything placed since the page opened is kept in state.history. The playhead (tl.t) picks the moment
  // shown on the globes; in live mode it is simply "now". Playing advances it at tl.speed × real time, and
  // edits it passes get their ripple / title / sound / Follow, as if they were arriving live.
  const sessionStart = Date.now();
  const tl = { live: true, playing: true, t: Date.now(), speed: 60, dragging: false, lastWall: performance.now(), lastLabel: 0 };
  function clockNow() { return tl.live ? Date.now() : tl.t; }
  const rangeStart = () => Math.min(sessionStart, state.history.length ? state.history[0].time : sessionStart);

  function goLive() {
    tl.live = true; tl.playing = true;
    WikiSky.setCutoff(null);
    windowDirty = true;
    renderTimeline();
  }
  function seek(t) {
    const end = Date.now();
    if (t >= end - 1000) { goLive(); return; }
    tl.live = false;
    tl.t = Math.max(rangeStart(), t);
    WikiSky.setCutoff(tl.t);
    windowDirty = true;
    renderTimeline();
  }
  function setPlaying(on) {
    if (tl.live && !on) { tl.live = false; tl.t = Date.now(); WikiSky.setCutoff(tl.t); } // pausing live freezes "now"
    tl.playing = on;
    tl.lastWall = performance.now();
    renderTimeline();
  }

  // Announce the edits the playhead passed in (a, b]. At high speeds many pass at once, so only a few
  // get ripples and only the newest gets a floating title, sound and Follow.
  function crossed(a, b) {
    let rippled = 0, latest = null;
    for (let i = upperBound(a); i < state.history.length && state.history[i].time <= b; i++) {
      const h = state.history[i];
      if (!h.sky && h.tier !== 'exact' && !state.showApprox) continue;
      if (rippled < 8) { announce(h, { label: false, sound: false }); rippled++; }
      latest = h;
    }
    if (!latest) return;
    const wall = performance.now();
    if (!latest.sky && wall - tl.lastLabel > 700) { tl.lastLabel = wall; announce(latest, { label: true, sound: true }); }
    else if (latest.sky || rippled <= 1) { if (state.sound) WikiSound.play(latest); }
  }

  setInterval(() => {
    const wall = performance.now();
    const dt = wall - tl.lastWall;
    tl.lastWall = wall;
    if (!tl.live && tl.playing && !tl.dragging) {
      const prev = tl.t;
      tl.t += dt * tl.speed;
      if (tl.t >= Date.now() - 500) goLive();
      else { crossed(prev, tl.t); WikiSky.setCutoff(tl.t); windowDirty = true; }
    }
    renderTimeline();
  }, 100);

  // --- UI ---
  const track = $('tl-track'), canvas = $('tl-hist');
  const PLAY_ICON = '<path d="M3 1.8v8.4c0 .5.5.8.9.5l6.4-4.2c.4-.2.4-.8 0-1L3.9 1.3c-.4-.3-.9 0-.9.5z"/>';
  const PAUSE_ICON = '<rect x="2.5" y="2" width="2.5" height="8" rx=".6"/><rect x="7" y="2" width="2.5" height="8" rx=".6"/>';
  const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function fmtAgo(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${pad(s % 60)}s ago`;
    return `${Math.floor(m / 60)}h ${pad(m % 60)}m ago`;
  }
  let lastHistDraw = 0;
  function renderTimeline() {
    const start = rangeStart(), end = Date.now(), span = Math.max(1000, end - start);
    const T = clockNow();
    const frac = Math.min(1, Math.max(0, (T - start) / span));
    $('tl-head').style.left = (frac * 100) + '%';
    $('tl-played').style.width = (frac * 100) + '%';
    const playing = tl.live || tl.playing;
    $('tl-play').querySelector('svg').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    $('tl-play').title = $('tl-play').ariaLabel = playing ? 'Pause' : 'Play';
    $('tl-live').classList.toggle('on', tl.live);
    $('tl-live').textContent = tl.live ? 'Live' : 'Go live';
    $('tl-time').textContent = tl.live ? `Live · recording since ${fmtClock(start)}` : `${fmtClock(T)} · ${fmtAgo(end - T)}`;
    track.setAttribute('aria-valuetext', tl.live ? 'Live' : fmtClock(T));
    const wall = performance.now();
    if (histDirty || wall - lastHistDraw > 2000) { drawHistogram(start, end); lastHistDraw = wall; histDirty = false; }
  }
  // Activity chart: placed edits per time bucket across the recording.
  function drawHistogram(start, end) {
    const dpr = window.devicePixelRatio || 1;
    const w = track.clientWidth, h = track.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = Math.max(1, Math.floor(w / 3)), span = Math.max(1000, end - start);
    const counts = new Array(n).fill(0);
    for (const it of state.history) counts[Math.min(n - 1, Math.max(0, Math.floor(((it.time - start) / span) * n)))]++;
    const max = Math.max(...counts, 1);
    g.fillStyle = 'rgba(122,162,255,0.55)';
    counts.forEach((c, i) => { if (!c) return; const bh = Math.max(1.5, (c / max) * (h - 6)); g.fillRect(i * 3, h - bh, 2, bh); });
  }

  // Scrubbing: drag anywhere on the track. Playback (if on) pauses during the drag and resumes after.
  function trackTime(clientX) {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return rangeStart() + f * Math.max(1000, Date.now() - rangeStart());
  }
  track.addEventListener('pointerdown', e => {
    tl.dragging = true;
    track.setPointerCapture(e.pointerId);
    seek(trackTime(e.clientX));
  });
  track.addEventListener('pointermove', e => { if (tl.dragging) seek(trackTime(e.clientX)); });
  const endDrag = () => { if (!tl.dragging) return; tl.dragging = false; tl.lastWall = performance.now(); };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('keydown', e => {
    const step = e.shiftKey ? 600e3 : 60e3;
    if (e.key === 'ArrowLeft') { seek(clockNow() - step); e.preventDefault(); }
    if (e.key === 'ArrowRight') { seek(clockNow() + step); e.preventDefault(); }
    if (e.key === 'Home') { seek(rangeStart()); e.preventDefault(); }
    if (e.key === 'End') { goLive(); e.preventDefault(); }
  });
  $('tl-play').onclick = () => setPlaying(!(tl.live || tl.playing));
  $('tl-start').onclick = () => seek(rangeStart());
  $('tl-live').onclick = goLive;
  $('tl-speed').onchange = e => { tl.speed = Number(e.target.value); };
  tl.speed = Number($('tl-speed').value);

  // ---------------- controls ----------------
  $('wiki-mode').onchange = e => { state.mode = e.target.value; };
  $('t-approx').onchange = e => { state.showApprox = e.target.checked; buildGroups(); };
  // Rotation pause/play buttons, one on each globe.
  function setRotateButton(btn, on) {
    btn.setAttribute('aria-pressed', String(!on));
    btn.querySelector('.ico').innerHTML = on
      ? '<rect x="2.5" y="2" width="2.5" height="8" rx=".6"/><rect x="7" y="2" width="2.5" height="8" rx=".6"/>'
      : '<path d="M3 1.8v8.4c0 .5.5.8.9.5l6.4-4.2c.4-.2.4-.8 0-1L3.9 1.3c-.4-.3-.9 0-.9.5z"/>';
    const lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = on ? 'Pause rotation' : 'Resume rotation';
    btn.title = on ? 'Pause rotation' : 'Resume rotation';
  }
  $('rot-earth').onclick = () => {
    state.rotate = !state.rotate;
    applyRotation();
    setRotateButton($('rot-earth'), state.rotate);
  };
  let skyRotate = true;
  $('rot-sky').onclick = () => {
    skyRotate = !skyRotate;
    WikiSky.setRotate(skyRotate);
    setRotateButton($('rot-sky'), skyRotate);
  };
  $('t-follow').onchange = e => {
    state.follow = e.target.checked;
    applyRotation();
    WikiSky.setFollow(state.follow);
    const latest = state.points[state.points.length - 1];
    if (state.follow && latest && !state.selected) { lastFollow = 0; followTo(latest); }
  };
  $('t-pause').onchange = e => { state.paused = e.target.checked; state.paused ? disconnect() : connect(); };
  $('t-sound').onchange = e => {
    state.sound = e.target.checked;
    state.sound ? WikiSound.enable() : WikiSound.disable();
  };

  WikiSky.onSelect = item => select(item);
  $('point-style').onchange = e => setPointStyle(e.target.value);
  let savedStyle = 'markers';
  try { savedStyle = localStorage.getItem('wikiGlobe.pointStyle') || 'markers'; } catch (e) { /* default */ }
  setPointStyle(savedStyle);

  // Simulated edits, for trying things out: ?simulate=Andromeda Galaxy|Ceres (dwarf planet)|Mars
  // or __wikiGlobe.simulate('Betelgeuse') in the console. These never touch Wikipedia except to look up the article.
  // Pass `at` to skip the lookup entirely, e.g. simulate('Test', 'en', { lat: 48.86, lng: 2.29 })
  // or simulate('Test sky', 'en', { sky: true, ra: 88.79, dec: 7.41 }).
  function simulate(title, lang = 'en', at) {
    const d = { type: 'edit', namespace: 0, title, server_name: `${lang}.wikipedia.org`, user: '(simulated)',
      comment: 'Simulated edit', length: { old: 1000, new: 1000 + Math.round(Math.random() * 600 - 200) },
      revision: {}, simulated: true };
    if (at && at.time) d.meta = { dt: new Date(at.time).toISOString() }; // backdate, e.g. to fill the timeline
    if (!at) return handle(d);
    state.considered.push(Date.now());
    state.resolved++;
    if (at.unplaced) return unplaced(d, lang, at.reason || 'Simulated: no location');
    place(d, lang, { tier: 'exact', reason: 'Simulated location', ...at });
  }
  const sim = new URLSearchParams(location.search).get('simulate');
  if (sim) sim.split('|').forEach((t, i) => setTimeout(() => simulate(t.trim()), 1500 + i * 700));

  connect();
  window.__wikiGlobe = { state, world, simulate }; // handy for debugging in the console
})();

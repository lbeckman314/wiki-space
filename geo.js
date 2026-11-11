/*
 * Location resolver: (wiki server, article title) -> location or null.
 *
 * 1. Article coordinates (GeoData) + Wikidata item id, batched per wiki (50 titles/request).
 * 2. No coordinates -> Wikidata item:
 *      P625 coordinate location                        -> exact
 *      P276 / P131 / P159 / P740 / P19 / P20 / P17 / P495 / P27 -> coordinates of that place
 *    Wikidata requests are batched (50 ids/request) and every place is cached.
 *
 * Results look like:
 *   { lat, lng, tier: 'exact'|'place'|'person'|'country', reason, placeLabel?, placeQid? }
 *   { sky: true, ra, dec, tier: 'exact'|'constellation', reason, distance? }   (astronomical objects)
 *   { offworld: 'mars' }   (surface coordinates on another globe)
 *   null                   (nothing usable)
 */
(function () {
  const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
  const EARTH = 'http://www.wikidata.org/entity/Q2';

  // Fallback chain, in priority order.
  const CHAIN = [
    { p: 'P276', tier: 'place',   verb: 'Located at' },
    { p: 'P131', tier: 'place',   verb: 'Located in' },
    { p: 'P159', tier: 'place',   verb: 'Headquartered in' },
    { p: 'P740', tier: 'place',   verb: 'Formed in' },
    { p: 'P19',  tier: 'person',  verb: 'Born in' },
    { p: 'P20',  tier: 'person',  verb: 'Died in' },
    { p: 'P17',  tier: 'country', verb: 'Country:' },
    { p: 'P495', tier: 'country', verb: 'From' },
    { p: 'P27',  tier: 'country', verb: 'Citizen of' },
  ];

  const BATCH = 50;
  // Pace: one request every 2 s (30/min) while the page is visible, one every 10 s (6/min) in a background tab.
  // Wikimedia's limit is per IP address across all its sites, measured at roughly 80/min in 2026, and other
  // tabs and people on the same address share it, so we stay well under. Batches simply get fuller.
  const GAP_MS = 2000;
  const HIDDEN_GAP_MS = 10000;
  const gap = () => (document.hidden ? HIDDEN_GAP_MS : GAP_MS);
  const MIN_AGE_MS = 1200;  // let a batch collect titles for at least this long before sending it
  const MAX_INFLIGHT = 3;
  const MAX_RETRIES = 3;
  // Wikimedia asks browser scripts to identify themselves with this header (browsers won't let us set User-Agent).
  const HEADERS = { 'Api-User-Agent': 'WikiSpace/1.0 (https://liambeckman.com/wiki-space/)' };

  // ---------- request pacing ----------
  // One shared cooldown: a 429's Retry-After counts down the same window on every Wikimedia site, so after one
  // 429 there's no point asking another wiki. Requests are spaced gap() apart, so a backlog never goes out
  // as a burst when the window reopens.
  let cooldownUntil = 0;
  let lastSent = 0;
  let inflight = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const turnWait = () => Math.max(cooldownUntil, lastSent + gap()) - Date.now();
  // Sleep in short steps so a tab coming back to the front speeds up within a second.
  const nap = ms => sleep(Math.min(ms, 1000));
  let gateChain = Promise.resolve();
  function takeTurn() { // resolves when it's our turn to send; turns are handed out one at a time, in order
    const p = gateChain.then(async () => {
      for (let w; (w = turnWait()) > 0;) await nap(w);
      lastSent = Date.now();
    });
    gateChain = p;
    return p;
  }
  function backOff(ms) { cooldownUntil = Math.max(cooldownUntil, Date.now() + ms); }

  // ---------- stats for the API panel ----------
  const stats = { hosts: new Map(), recent: [], sent: [], rateLimited: 0, last429: null, started: Date.now() };
  function record(url, status, ms, retryAfter) {
    const u = new URL(url);
    const n = (u.searchParams.get('titles') || u.searchParams.get('ids') || '').split('|').filter(Boolean).length;
    let h = stats.hosts.get(u.host);
    if (!h) { h = { requests: 0, ok: 0, rateLimited: 0, errors: 0, totalMs: 0, items: 0, sent: [] }; stats.hosts.set(u.host, h); }
    const now = Date.now();
    h.requests++; h.totalMs += ms; h.items += n; h.sent.push(now); stats.sent.push(now);
    if (status === 200) h.ok++;
    else if (status === 429) { h.rateLimited++; stats.rateLimited++; stats.last429 = { at: now, host: u.host, retryAfter }; }
    else h.errors++;
    stats.recent.unshift({ at: now, host: u.host, status, ms, n });
    if (stats.recent.length > 12) stats.recent.pop();
  }
  const lastMinute = (list, now) => { while (list.length && list[0] <= now - 60e3) list.shift(); return list.length; };

  // Fetch JSON. The first attempt's turn was already taken by the pump; retries wait for a turn of their own.
  async function send(url) {
    inflight++;
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await takeTurn();
        let r;
        const t0 = performance.now();
        try {
          r = await fetch(url, { headers: HEADERS });
        } catch (netErr) {
          record(url, 'network error', performance.now() - t0);
          // A rate-limit response without CORS headers reaches us as a network error, so back off and retry it too.
          if (attempt >= MAX_RETRIES) throw netErr;
          backOff(2000 * Math.pow(2, attempt));
          continue;
        }
        const retryAfter = Number(r.headers.get('Retry-After')) * 1000;
        record(url, r.status, performance.now() - t0, retryAfter || null);
        if (r.ok) return await r.json();
        if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status);
        backOff(retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, attempt));
        if (attempt >= MAX_RETRIES) throw new Error('HTTP ' + r.status + ' after retries');
      }
    } finally {
      inflight--;
    }
  }
  const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  // ---------- batching queues and the pump ----------
  // Every batcher (one per wiki for pages, plus Wikidata) adds to these queues. The pump takes one turn at a
  // time and spends it on the queue that has waited longest, so busy queues keep filling up meanwhile and
  // each request carries more titles.
  const queues = new Set(); // { fetchBatch, label, group, items: Map(key -> deferred), since }
  let pumping = false;
  function nextQueue(now) {
    let best = null, soonest = Infinity;
    for (const q of queues) {
      const readyAt = q.items.size >= BATCH ? 0 : q.since + MIN_AGE_MS;
      if (readyAt <= now) { if (!best || q.since < best.since) best = q; }
      else soonest = Math.min(soonest, readyAt);
    }
    return { q: best, wait: soonest - now };
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queues.size) {
        if (inflight >= MAX_INFLIGHT) { await sleep(100); continue; }
        const w = turnWait();
        if (w > 0) { await nap(w); continue; }
        const { q, wait } = nextQueue(Date.now());
        if (!q) { await sleep(wait); continue; }
        lastSent = Date.now(); // this is our turn (the gate isn't held: retries queue behind it)
        const entries = [...q.items.entries()].slice(0, BATCH);
        entries.forEach(([k]) => q.items.delete(k));
        if (!q.items.size) queues.delete(q);
        q.fetchBatch(q.group, entries.map(([k]) => k))
          .then(results => entries.forEach(([k, d]) => d.resolve(results.get(k))))
          .catch(err => { console.warn('batch failed', q.group, err); entries.forEach(([, d]) => d.resolve(undefined)); });
      }
    } finally {
      pumping = false;
    }
  }
  function makeBatcher(fetchBatch, label = group => group) {
    const byGroup = new Map();
    return function enqueue(group, key) {
      let q = byGroup.get(group);
      if (!q || !queues.has(q)) {
        q = { fetchBatch, label: label(group), group, items: new Map(), since: Date.now() };
        byGroup.set(group, q); queues.add(q);
      }
      let d = q.items.get(key);
      if (!d) {
        d = {}; d.promise = new Promise(r => (d.resolve = r));
        q.items.set(key, d);
      }
      pump();
      return d.promise;
    };
  }
  // For the status line: how long lookups are paused, and how long the oldest waiting lookup has waited.
  function lookupStatus() {
    const now = Date.now();
    let oldest = now;
    for (const q of queues) oldest = Math.min(oldest, q.since);
    return { pausedMs: Math.max(0, cooldownUntil - now), behindMs: now - oldest };
  }
  // Everything the API panel shows. Plain data, recomputed on each call.
  function lookupDetails() {
    const now = Date.now();
    return {
      ...lookupStatus(),
      pacePerMin: Math.round(60e3 / gap()),
      hiddenPacePerMin: Math.round(60e3 / HIDDEN_GAP_MS),
      hidden: document.hidden,
      batchMax: BATCH,
      sentLastMin: lastMinute(stats.sent, now),
      inflight,
      rateLimited: stats.rateLimited,
      last429: stats.last429,
      since: stats.started,
      waiting: [...queues].map(q => ({ label: q.label, items: q.items.size, ageMs: now - q.since })).sort((a, b) => b.ageMs - a.ageMs),
      hosts: [...stats.hosts].map(([host, h]) => ({
        host, requests: h.requests, ok: h.ok, rateLimited: h.rateLimited, errors: h.errors, lastMin: lastMinute(h.sent, now),
        avgMs: h.requests ? Math.round(h.totalMs / h.requests) : 0, perRequest: h.requests ? +(h.items / h.requests).toFixed(1) : 0,
      })).sort((a, b) => b.requests - a.requests),
      recent: stats.recent.slice(),
    };
  }

  // ---------- Wikidata claim helpers ----------
  function bestClaim(claims, p) {
    const list = (claims && claims[p]) || [];
    const usable = list.filter(c => c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.snaktype === 'value');
    return usable.find(c => c.rank === 'preferred') || usable[0] || null;
  }
  function coordOf(claims) {
    const c = bestClaim(claims, 'P625');
    if (!c) return null;
    const v = c.mainsnak.datavalue.value;
    if (v.globe && v.globe !== EARTH) return { offworld: v.globe.split('/').pop() };
    return { lat: v.latitude, lng: v.longitude };
  }

  // ---------- step 1: wiki API (coordinates + wikibase item) ----------
  const fetchPages = makeBatcher(async (server, titles) => {
    const url = `https://${server}/w/api.php?` + qs({
      action: 'query', format: 'json', formatversion: 2, origin: '*',
      prop: 'coordinates|pageprops', ppprop: 'wikibase_item', colimit: 'max',
      titles: titles.join('|'),
    });
    const data = await send(url);
    const q = data.query || {};
    const norm = new Map((q.normalized || []).map(n => [n.from, n.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    const out = new Map();
    for (const t of titles) {
      const p = pages.get(norm.get(t) || t);
      if (!p || p.missing) { out.set(t, null); continue; }
      const c = p.coordinates && p.coordinates[0];
      out.set(t, {
        coord: c ? (c.globe === 'earth' ? { lat: c.lat, lng: c.lon } : { offworld: c.globe }) : null,
        qid: (p.pageprops && p.pageprops.wikibase_item) || null,
      });
    }
    return out;
  });

  // ---------- step 2: Wikidata entities ----------
  // Items being edited: we only need their claims.
  const fetchItems = makeBatcher(async (_, ids) => {
    const data = await send(WIKIDATA_API + '?' + qs({
      action: 'wbgetentities', format: 'json', origin: '*', props: 'claims', ids: ids.join('|'),
    }));
    return new Map(ids.map(id => [id, (data.entities && data.entities[id] && data.entities[id].claims) || null]));
  }, () => 'Wikidata: edited items');

  // Entities referenced by those items (places, constellations, orbit epochs): coordinates + labels.
  // Cached forever: cities, countries and constellations repeat a lot.
  const placeCache = new Map(); // qid -> Promise<{coord, labels, claims}|null>
  const fetchPlacesBatch = makeBatcher(async (_, ids) => {
    const data = await send(WIKIDATA_API + '?' + qs({
      action: 'wbgetentities', format: 'json', origin: '*', props: 'claims|labels',
      ids: ids.join('|'), languages: PLACE_LANGS.join('|'),
    }));
    const out = new Map();
    for (const id of ids) {
      const e = data.entities && data.entities[id];
      if (!e || e.missing !== undefined) { out.set(id, null); continue; }
      const c = coordOf(e.claims);
      const labels = {};
      for (const [l, v] of Object.entries(e.labels || {})) labels[l] = v.value;
      out.set(id, { coord: c && !c.offworld ? c : null, labels, claims: e.claims });
    }
    return out;
  }, () => 'Wikidata: places');
  // Labels: fetch English plus the languages of the bigger Wikipedias in one go.
  const PLACE_LANGS = ['en', 'de', 'fr', 'es', 'ja', 'ru', 'it', 'zh', 'pt', 'ar', 'pl', 'nl', 'fa', 'uk', 'he', 'sv', 'ko', 'tr', 'id', 'vi'];
  function fetchPlace(qid) {
    if (!placeCache.has(qid)) {
      const p = fetchPlacesBatch('wd', qid).then(v => {
        if (v === undefined) placeCache.delete(qid); // network error: allow a retry later
        return v || null;
      });
      placeCache.set(qid, p);
    }
    return placeCache.get(qid);
  }
  const labelOf = (pl, lang, fallback) => (pl && (pl.labels[lang] || pl.labels.en || Object.values(pl.labels)[0])) || fallback;

  // ---------- sky (celestial) coordinates ----------
  // Returns { sky: true, ra, dec (degrees), tier: 'exact'|'constellation', reason } or null.
  const DEG = 'http://www.wikidata.org/entity/Q28390';
  const AU = 'http://www.wikidata.org/entity/Q1811';
  const KM = 'http://www.wikidata.org/entity/Q828224';
  const DIST_UNITS = {
    'http://www.wikidata.org/entity/Q531': 'light-years',
    'http://www.wikidata.org/entity/Q12129': 'parsecs',
    'http://www.wikidata.org/entity/Q3773454': 'megaparsecs',
    [AU]: 'AU',
  };
  function quantity(claims, p, units) {
    const c = bestClaim(claims, p);
    if (!c) return null;
    const v = c.mainsnak.datavalue.value;
    if (units && !units.includes(v.unit)) return null;
    return { amount: Number(v.amount), unit: v.unit };
  }
  function distanceText(claims) {
    const d = quantity(claims, 'P2583');
    if (!d || !DIST_UNITS[d.unit]) return null;
    return `${d.amount.toLocaleString(undefined, { maximumSignificantDigits: 3 })} ${DIST_UNITS[d.unit]} away`;
  }

  async function resolveSky(qid, claims, lang) {
    const Sky = window.WikiSky;
    if (!Sky) return null;
    const now = new Date();

    // 1. Sun, Moon and planets: computed with astronomy-engine.
    const planet = Sky.planetPosition(qid, now);
    if (planet) return { sky: true, ...planet, tier: 'exact', reason: 'Position in the sky today (computed)' };

    // 2. Fixed objects (stars, galaxies, nebulae...): right ascension + declination.
    const ra = quantity(claims, 'P6257', [DEG]), dec = quantity(claims, 'P6258', [DEG]);
    if (ra && dec) {
      return { sky: true, ra: ra.amount, dec: dec.amount, tier: 'exact', reason: 'Right ascension / declination', distance: distanceText(claims) };
    }

    // 3. Asteroids, comets, moons of the Sun: Keplerian orbital elements -> today's position.
    const a = quantity(claims, 'P2233', [AU, KM]);
    const el = { e: quantity(claims, 'P1096'), i: quantity(claims, 'P2045', [DEG]), node: quantity(claims, 'P2213', [DEG]),
      peri: quantity(claims, 'P2248', [DEG]), M: quantity(claims, 'P2325', [DEG]) };
    const epochClaim = bestClaim(claims, 'P6259');
    if (a && Object.values(el).every(Boolean) && epochClaim && epochClaim.mainsnak.datavalue.value.id) {
      const epochItem = await fetchPlace(epochClaim.mainsnak.datavalue.value.id);
      const epoch = Sky.parseEpoch(epochItem && epochItem.labels.en);
      if (epoch) {
        const pos = Sky.orbitPosition({
          a: a.unit === KM ? a.amount / 149597870.7 : a.amount,
          e: el.e.amount, i: el.i.amount, node: el.node.amount, peri: el.peri.amount, M: el.M.amount, epoch,
        }, now);
        if (pos) return { sky: true, ...pos, tier: 'exact', reason: 'Position in the sky today (from its orbit)' };
      }
    }

    // 4. Only a constellation: approximate, at the constellation's centre.
    const con = bestClaim(claims, 'P59');
    if (con && con.mainsnak.datavalue.value.id) {
      const conItem = await fetchPlace(con.mainsnak.datavalue.value.id);
      const centre = conItem && Sky.constellationCentre(conItem.labels.en);
      if (centre) return { sky: true, ...centre, tier: 'constellation', reason: `In the constellation ${labelOf(conItem, lang, centre.name)}`, distance: distanceText(claims) };
    }
    return null;
  }

  async function resolveViaWikidata(qid, lang) {
    const claims = await fetchItems('wd', qid);
    if (!claims) return null;
    const own = coordOf(claims);
    if (own && !own.offworld) return { ...own, tier: 'exact', reason: 'Wikidata coordinates (P625)' };

    const sky = await resolveSky(qid, claims, lang);
    if (sky) return sky;
    if (own) return own; // surface coordinates on another body, and no sky position

    const candidates = CHAIN
      .map(step => { const c = bestClaim(claims, step.p); return c && c.mainsnak.datavalue.value.id ? { step, qid: c.mainsnak.datavalue.value.id } : null; })
      .filter(Boolean);
    if (!candidates.length) return null;
    // Fetch all candidate places in parallel (batched + cached), take the first in chain order that has coordinates.
    const places = await Promise.all(candidates.map(c => fetchPlace(c.qid)));
    for (let i = 0; i < candidates.length; i++) {
      const pl = places[i];
      if (!pl || !pl.coord) continue;
      const { step, qid: pq } = candidates[i];
      const label = labelOf(pl, lang, pq);
      return { lat: pl.coord.lat, lng: pl.coord.lng, tier: step.tier, reason: `${step.verb} ${label}`, prop: step.p, placeLabel: label, placeQid: pq };
    }
    return null;
  }

  // ---------- public API ----------
  const pageCache = new Map(); // `${server}|${title}` -> Promise
  const LIMIT = 20000;

  function resolveLocation(server, title, lang) {
    const key = server + '|' + title;
    if (pageCache.has(key)) return pageCache.get(key);
    const p = fetchPages(server, title).then(page => {
      if (page === undefined) { pageCache.delete(key); return null; } // network error: don't cache
      if (!page) return null;
      if (page.coord && page.coord.offworld) {
        // Surface coordinates on another body (e.g. the Moon article): prefer a sky position if Wikidata has one.
        if (!page.qid) return page.coord;
        return resolveViaWikidata(page.qid, lang).then(r => (r && r.sky ? { ...r, qid: page.qid } : page.coord));
      }
      if (page.coord) return { ...page.coord, tier: 'exact', reason: 'Article coordinates', qid: page.qid };
      if (page.qid) return resolveViaWikidata(page.qid, lang).then(r => (r ? { ...r, qid: page.qid } : null));
      return null;
    }).catch(() => null);
    if (pageCache.size > LIMIT) pageCache.delete(pageCache.keys().next().value);
    pageCache.set(key, p);
    return p;
  }

  window.WikiGeo = { resolveLocation, lookupStatus, lookupDetails };
})();

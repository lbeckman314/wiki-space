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
  const FLUSH_MS = 1200;
  const MAX_INFLIGHT = 3;
  const MAX_RETRIES = 3;

  // ---------- small fetch scheduler ----------
  // Caps concurrent requests, and on HTTP 429 (rate limited) backs off globally:
  // every request waits out the server's Retry-After (or an exponential delay) before retrying.
  let inflight = 0;
  let cooldownUntil = 0;
  const waiting = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function limitedFetch(url) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        inflight++;
        try {
          for (let attempt = 0; ; attempt++) {
            const wait = cooldownUntil - Date.now();
            if (wait > 0) await sleep(wait);
            let r;
            try {
              r = await fetch(url);
            } catch (netErr) {
              // A rate-limit response without CORS headers reaches us as a network error, so back off and retry it too.
              if (attempt >= MAX_RETRIES) throw netErr;
              cooldownUntil = Math.max(cooldownUntil, Date.now() + 2000 * Math.pow(2, attempt));
              continue;
            }
            if (r.ok) { resolve(await r.json()); return; }
            if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status);
            if (attempt >= MAX_RETRIES) throw new Error('HTTP ' + r.status + ' after retries');
            const retryAfter = Number(r.headers.get('Retry-After')) * 1000;
            const delay = retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, attempt);
            cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
          }
        } catch (err) {
          reject(err);
        } finally {
          inflight--;
          if (waiting.length) waiting.shift()();
        }
      };
      inflight < MAX_INFLIGHT ? run() : waiting.push(run);
    });
  }
  const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  // ---------- generic batching queue ----------
  function makeBatcher(fetchBatch) {
    const queues = new Map(); // groupKey -> { items: Map(key -> deferred), timer }
    function flush(group) {
      const q = queues.get(group);
      if (!q) return;
      clearTimeout(q.timer); q.timer = null;
      const entries = [...q.items.entries()].slice(0, BATCH);
      entries.forEach(([k]) => q.items.delete(k));
      if (q.items.size) q.timer = setTimeout(() => flush(group), FLUSH_MS);
      else queues.delete(group);
      fetchBatch(group, entries.map(([k]) => k))
        .then(results => entries.forEach(([k, d]) => d.resolve(results.get(k))))
        .catch(err => { console.warn('batch failed', group, err); entries.forEach(([, d]) => d.resolve(undefined)); });
    }
    return function enqueue(group, key) {
      let q = queues.get(group);
      if (!q) { q = { items: new Map(), timer: null }; queues.set(group, q); }
      let d = q.items.get(key);
      if (!d) {
        d = {}; d.promise = new Promise(r => (d.resolve = r));
        q.items.set(key, d);
      }
      if (q.items.size >= BATCH) flush(group);
      else if (!q.timer) q.timer = setTimeout(() => flush(group), FLUSH_MS);
      return d.promise;
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
    const data = await limitedFetch(url);
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
    const data = await limitedFetch(WIKIDATA_API + '?' + qs({
      action: 'wbgetentities', format: 'json', origin: '*', props: 'claims', ids: ids.join('|'),
    }));
    return new Map(ids.map(id => [id, (data.entities && data.entities[id] && data.entities[id].claims) || null]));
  });

  // Entities referenced by those items (places, constellations, orbit epochs): coordinates + labels.
  // Cached forever: cities, countries and constellations repeat a lot.
  const placeCache = new Map(); // qid -> Promise<{coord, labels, claims}|null>
  const fetchPlacesBatch = makeBatcher(async (_, ids) => {
    const data = await limitedFetch(WIKIDATA_API + '?' + qs({
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
  });
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

  window.WikiGeo = { resolveLocation, get cooldownMs() { return Math.max(0, cooldownUntil - Date.now()); } };
})();

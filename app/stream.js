// The live edit stream, and turning each edit into a placed (or unplaced) item.
import { $, STREAM, TOP_WIKIS, MAX_UNPLACED, motion, isFresh, state, flags, tl } from './core.js';
import { record } from './history.js';
import { announce } from './globe.js';

let es = null;
// For the API panel: when the stream connected, how often it dropped, and events per minute.
const streamStats = { connectedAt: null, drops: 0, events: [], kept: 0 };
export function streamDetails() {
  const cutoff = Date.now() - 60e3;
  while (streamStats.events.length && streamStats.events[0] <= cutoff) streamStats.events.shift();
  return { state: streamState(), paused: !es, connectedAt: streamStats.connectedAt, drops: streamStats.drops,
    eventsLastMin: streamStats.events.length, url: STREAM };
}
export function setStatus(kind, text) {
  $('status-dot').className = 'dot ' + kind;
  $('status-text').textContent = text;
}

// Resuming after "Pause stream" replays what was missed (up to CATCH_UP_MAX) with the stream's ?since=.
// Dropped connections recover by themselves: EventSource reconnects and resumes from the last event.
const CATCH_UP_MAX = 15 * 60e3;
let pausedAt = null, catchingUp = false;
const seenIds = new Set(), seenOrder = [];
export function connect(since) {
  if (es) es.close();
  catchingUp = !!since;
  setStatus('', catchingUp ? 'catching up on missed edits…' : 'connecting…');
  es = new EventSource(since ? `${STREAM}?since=${encodeURIComponent(new Date(since).toISOString())}` : STREAM);
  es.onopen = () => { streamStats.connectedAt = Date.now(); if (!catchingUp) setStatus('live', 'live from Wikipedia'); };
  es.onerror = () => { streamStats.drops++; setStatus('down', 'reconnecting…'); }; // EventSource retries on its own
  es.onmessage = onEvent;
}
export function disconnect() { if (es) es.close(); es = null; pausedAt = Date.now(); setStatus('down', 'paused'); }
export function resume() {
  // Start a little before the pause so nothing falls in the gap; duplicates are dropped in onEvent.
  connect(pausedAt ? Math.max(pausedAt - 5000, Date.now() - CATCH_UP_MAX) : null);
  pausedAt = null;
}
// For the status line: 'catching-up', 'open', or 'closed'.
export function streamState() {
  if (!es || es.readyState !== EventSource.OPEN) return 'closed';
  return catchingUp ? 'catching-up' : 'open';
}

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
  streamStats.events.push(Date.now());
  const id = d.meta && d.meta.id;
  if (id) {
    if (seenIds.has(id)) return; // already seen (catch-up overlaps the moment of pausing)
    seenIds.add(id); seenOrder.push(id);
    if (seenOrder.length > 20000) seenIds.delete(seenOrder.shift());
  }
  if (catchingUp && d.meta && Date.parse(d.meta.dt) > Date.now() - 10e3) { catchingUp = false; setStatus('live', 'live from Wikipedia'); }
  if (!accept(d)) return;
  handle(d);
}

function handle(d) {
  const lang = d.server_name.split('.')[0];
  // The per-minute rate counts edits by when they were made, so a catch-up burst doesn't inflate it.
  state.considered.push(Math.min(Date.now(), (d.meta && Date.parse(d.meta.dt)) || Date.now()));
  state.considered.sort((a, b) => a - b);
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
  // When the edit was made (not when its location was found), so history stays in true order.
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
  flags.listDirty = true;
}

function place(d, lang, loc) {
  const base = { ...makeItem(d, lang), tier: loc.tier, reason: loc.reason, qid: loc.qid };
  state.placed++;
  flags.listDirty = true;

  if (loc.sky) {
    const item = { ...base, sky: true, ra: loc.ra, dec: loc.dec, distance: loc.distance,
      lat: loc.dec, lng: WikiSky.raToLng(loc.ra) };
    state.sky++;
    record(item);
    // While replaying, or for old edits (catch-up), it appears without a ripple.
    const announceNow = tl.live && isFresh(item) && !document.hidden;
    WikiSky.add(item, { quiet: !announceNow || motion.reduce });
    if (tl.live && isFresh(item) && state.sound) WikiSound.play(item);
    return;
  }

  // Approximate edits sit exactly on their place; nearby edits are merged into one marker (points.js).
  const item = { ...base, lat: loc.lat, lng: loc.lng };
  loc.tier === 'exact' ? state.exact++ : state.approx++;
  record(item);
  if (tl.live && isFresh(item) && (item.tier === 'exact' || state.showApprox)) announce(item);
}

// Simulated edits, for trying things out: ?simulate=Andromeda Galaxy|Ceres (dwarf planet)|Mars
// or __wikiSpace.simulate('Betelgeuse') in the console. These never touch Wikipedia except to look up the article.
// Pass `at` to skip the lookup entirely, e.g. simulate('Test', 'en', { lat: 48.86, lng: 2.29 })
// or simulate('Test sky', 'en', { sky: true, ra: 88.79, dec: 7.41 }).
export function simulate(title, lang = 'en', at) {
  const d = { type: 'edit', namespace: 0, title, server_name: `${lang}.wikipedia.org`, user: '(simulated)',
    comment: 'Simulated edit', length: { old: 1000, new: 1000 + Math.round(Math.random() * 600 - 200) },
    revision: {}, simulated: true };
  if (at && at.time) d.meta = { dt: new Date(at.time).toISOString() }; // backdate, e.g. to test the 10-minute window
  if (!at) return handle(d);
  state.considered.push(Date.now());
  state.resolved++;
  if (at.unplaced) return unplaced(d, lang, at.reason || 'Simulated: no location');
  place(d, lang, { tier: 'exact', reason: 'Simulated location', ...at });
}

// The live edit stream (Wikimedia EventStreams), and turning each edit into a placed or unplaced item.
import { $, STREAM, TOP_WIKIS, MAX_UNPLACED, motion, state, flags } from './core.js';
import { record } from './history.js';
import { announce } from './globe.js';
import { WikiSky } from './sky.js';
import { WikiGeo } from './geo.js';

// Edits placed more than this long after they were made (slow lookups) appear without a ripple.
const FRESH_MS = 60e3;
const isFresh = item => Date.now() - item.time < FRESH_MS;

// ---------------- connection ----------------
let source = null;
const streamStats = { connectedAt: null, drops: 0, events: [] }; // for the API panel

export function connect() {
  setStatus('', 'connecting…');
  source = new EventSource(STREAM);
  source.onopen = () => { streamStats.connectedAt = Date.now(); setStatus('live', 'live from Wikipedia'); };
  // EventSource reconnects by itself and carries on from the last event it received.
  source.onerror = () => { streamStats.drops++; setStatus('down', 'reconnecting…'); };
  source.onmessage = onEvent;
}
// Used by the tests, so only simulated edits appear.
export function disconnect() {
  if (source) source.close();
  source = null;
  setStatus('down', 'stopped');
}
export const isConnected = () => !!source && source.readyState === EventSource.OPEN;

export function setStatus(kind, text) {
  $('status-dot').className = 'dot ' + kind;
  $('status-text').textContent = text;
}

export function streamDetails() {
  const cutoff = Date.now() - 60e3;
  while (streamStats.events.length && streamStats.events[0] <= cutoff) streamStats.events.shift();
  return { connected: isConnected(), connectedAt: streamStats.connectedAt, drops: streamStats.drops, eventsLastMin: streamStats.events.length };
}

// ---------------- incoming edits ----------------
// Human edits to articles on the chosen Wikipedias.
function wanted(d) {
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
  if (wanted(d)) handle(d);
}

function handle(d) {
  const lang = d.server_name.split('.')[0];
  state.considered.push(Date.now());
  WikiGeo.resolveLocation(d.server_name, d.title, lang).then(loc => {
    if (!loc) return unplaced(d, lang, 'No coordinates, and no related place on Wikidata');
    if (loc.offworld) {
      const body = String(loc.offworld);
      return unplaced(d, lang, `On the surface of ${body.charAt(0).toUpperCase() + body.slice(1)}`);
    }
    place(d, lang, loc);
  });
}

// ---------------- items ----------------
let seq = 0;
function makeItem(d, lang) {
  const delta = ((d.length && d.length.new) || 0) - ((d.length && d.length.old) || 0);
  const kind = d.type === 'new' ? 'new' : delta > 0 ? 'add' : delta < 0 ? 'remove' : 'neutral';
  // When the edit was made (not when its place was found), so history stays in order.
  const made = (d.meta && Date.parse(d.meta.dt)) || (d.timestamp && d.timestamp * 1000) || Date.now();
  return {
    id: ++seq, time: Math.min(made, Date.now()), kind, delta, lang,
    title: d.title, server: d.server_name, user: d.user, comment: d.comment, simulated: !!d.simulated,
    revOld: d.revision && d.revision.old, revNew: d.revision && d.revision.new,
  };
}

function unplaced(d, lang, reason) {
  state.unplaced++;
  state.unplacedList.push({ ...makeItem(d, lang), unplaced: true, reason });
  if (state.unplacedList.length > MAX_UNPLACED) state.unplacedList.shift();
  flags.listDirty = true;
}

function place(d, lang, loc) {
  const base = { ...makeItem(d, lang), tier: loc.tier, reason: loc.reason, qid: loc.qid };
  state.placed++;
  flags.listDirty = true;

  if (loc.sky) {
    // On the sky map, longitude is minus the right ascension and latitude is the declination.
    const item = { ...base, sky: true, ra: loc.ra, dec: loc.dec, distance: loc.distance, lat: loc.dec, lng: WikiSky.raToLng(loc.ra) };
    state.sky++;
    record(item);
    WikiSky.add(item, { quiet: !isFresh(item) || document.hidden || motion.reduce });
    return;
  }

  const item = { ...base, lat: loc.lat, lng: loc.lng };
  record(item);
  if (isFresh(item) && (item.tier === 'exact' || state.showApprox)) announce(item);
}

// ---------------- simulated edits ----------------
// For trying things out: ?simulate=Andromeda Galaxy|Mars, or __wikiSpace.simulate('Betelgeuse') in the console.
// Without `at`, the article's place is looked up as usual. With `at`, the lookup is skipped:
//   simulate('Test', 'en', { lat: 48.86, lng: 2.29 })          a place on Earth
//   simulate('Test', 'en', { sky: true, ra: 88.79, dec: 7.41 }) a place in the sky
//   simulate('Test', 'en', { unplaced: true, reason: '…' })     not placed
// `at` can also carry tier, reason and time (to backdate the edit).
export function simulate(title, lang = 'en', at) {
  const d = {
    type: 'edit', namespace: 0, title, server_name: `${lang}.wikipedia.org`, user: '(simulated)',
    comment: 'Simulated edit', length: { old: 1000, new: 1000 + Math.round(Math.random() * 600 - 200) },
    revision: {}, simulated: true,
  };
  if (at && at.time) d.meta = { dt: new Date(at.time).toISOString() };
  if (!at) return handle(d);
  state.considered.push(Date.now());
  if (at.unplaced) return unplaced(d, lang, at.reason || 'Simulated: no location');
  place(d, lang, { tier: 'exact', reason: 'Simulated location', ...at });
}

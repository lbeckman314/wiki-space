// History and the timeline bar.
// Everything placed since the page opened is kept in state.history, ordered by when each edit was made.
// The playhead (tl.t) picks the moment shown on the globes; in live mode it is simply "now". Playing
// advances it at tl.speed × real time, and edits it passes get their ripple / title / sound / Follow, as if
// they were arriving live.
import { $, POINT_LIFE, MAX_POINTS, MAX_HISTORY, state, flags, tl, clockNow, upperBound, fmtClock, fmtAgo } from './core.js';
import { announce } from './globe.js';

export function record(item) {
  state.history.splice(upperBound(item.time), 0, item); // lookups finish out of order, so insert sorted
  if (state.history.length > MAX_HISTORY) state.history.shift();
  flags.windowDirty = true;
  flags.histDirty = true;
}
// Earth edits shown at the playhead: the POINT_LIFE before it (plus the selected edit, wherever it is).
export function computeWindow() {
  const T = clockNow();
  const out = [];
  for (let i = upperBound(T - POINT_LIFE); i < state.history.length && state.history[i].time <= T; i++) {
    if (!state.history[i].sky) out.push(state.history[i]);
  }
  const sel = state.selected;
  if (sel && !sel.sky && !sel.unplaced && !out.includes(sel)) sel.time < T ? out.unshift(sel) : out.push(sel);
  state.points = out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;
  flags.windowDirty = false;
}

const sessionStart = Date.now();
const rangeStart = () => Math.min(sessionStart, state.history.length ? state.history[0].time : sessionStart);

export function goLive() {
  tl.live = true; tl.playing = true;
  WikiSky.setCutoff(null);
  flags.windowDirty = true;
  renderTimeline();
}
function seek(t) {
  const end = Date.now();
  if (t >= end - 1000) { goLive(); return; }
  tl.live = false;
  tl.t = Math.max(rangeStart(), t);
  WikiSky.setCutoff(tl.t);
  flags.windowDirty = true;
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

// ---------------- UI ----------------
const PLAY_ICON = '<path d="M3 1.8v8.4c0 .5.5.8.9.5l6.4-4.2c.4-.2.4-.8 0-1L3.9 1.3c-.4-.3-.9 0-.9.5z"/>';
const PAUSE_ICON = '<rect x="2.5" y="2" width="2.5" height="8" rx=".6"/><rect x="7" y="2" width="2.5" height="8" rx=".6"/>';
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
  $('tl-track').setAttribute('aria-valuetext', tl.live ? 'Live' : fmtClock(T));
  const wall = performance.now();
  if (flags.histDirty || wall - lastHistDraw > 2000) { drawHistogram(start, end); lastHistDraw = wall; flags.histDirty = false; }
}
// Activity chart: placed edits per time bucket across the recording.
function drawHistogram(start, end) {
  const track = $('tl-track'), canvas = $('tl-hist');
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

export function initTimeline() {
  const track = $('tl-track');
  // Scrubbing: drag anywhere on the track.
  const trackTime = clientX => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return rangeStart() + f * Math.max(1000, Date.now() - rangeStart());
  };
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

  // Playback: advance the playhead ten times a second.
  setInterval(() => {
    const wall = performance.now();
    const dt = wall - tl.lastWall;
    tl.lastWall = wall;
    if (!tl.live && tl.playing && !tl.dragging) {
      const prev = tl.t;
      tl.t += dt * tl.speed;
      if (tl.t >= Date.now() - 500) goLive();
      else { crossed(prev, tl.t); WikiSky.setCutoff(tl.t); flags.windowDirty = true; }
    }
    renderTimeline();
  }, 100);
}

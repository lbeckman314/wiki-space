// Start-up: wires the controls, runs the update loops and connects to the live stream.
// Modules only declare things when they load; everything that touches the page starts here, in order.
import { $, RING_LIFE, LABEL_LIFE, motionQuery, motion, state, flags, tl, view, DEFAULTS, urlParam, setUrlParam } from './core.js';
import { world, initGlobe, applyRotation, followNow, watchHover } from './globe.js';
import { initPoints, buildGroups, setPointStyle, zoomChanged } from './points.js';
import { computeWindow } from './history.js';
import { connect, disconnect, resume, streamState, setStatus, simulate } from './stream.js';
import { initSidebar } from './sidebar.js';
import { initCard, select } from './card.js';
import { initApiPanel } from './apipanel.js';

initGlobe();
initPoints();
initSidebar();
initCard();
initApiPanel();

// ---------------- update loops ----------------
// Globe layers: at most four updates a second, and only for what changed.
let lastWindow = 0;
setInterval(() => {
  if (document.hidden) return; // nothing to draw; flags stay set and are handled when the tab is back
  const now = Date.now();
  const ringsBefore = state.rings.length;
  state.rings = state.rings.filter(r => now - r.born < RING_LIFE);
  state.labels.forEach(l => { l.el.classList.toggle('fading', now - l.born > LABEL_LIFE - 800); });
  // Recompute the on-screen window when edits arrive, the playhead moves, or (live) once a second for expiry.
  let rebuild = false;
  if (flags.windowDirty || (tl.live && now - lastWindow > 1000)) { computeWindow(); lastWindow = now; rebuild = true; }
  // Re-cluster when the window changed, or when the zoom has changed noticeably.
  if (rebuild || flags.dirty || zoomChanged(world.pointOfView().altitude)) buildGroups();
  // Labels are re-sent only when one is added: re-sending re-attaches their elements.
  if (flags.dirty || ringsBefore !== state.rings.length) world.ringsData(state.rings.slice());
  if (flags.labelsDirty) world.htmlElementsData(state.labels.slice());
  flags.labelsDirty = false;
  flags.dirty = false;
}, 250);
// Re-colour markers for fading every few seconds.
setInterval(buildGroups, 5000);

// Stats and the status line, once a second.
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
  const s = streamState();
  if (s === 'catching-up') setStatus('', 'catching up on missed edits…');
  else if (s === 'open') {
    const paused = pausedText();
    paused ? setStatus('', 'live · ' + paused) : setStatus('live', 'live from Wikipedia');
  }
}, 1000);

// Short waits are routine; only mention ones people would notice.
function pausedText() {
  const { pausedMs, behindMs } = WikiGeo.lookupStatus();
  if (pausedMs > 10e3) return `Wikipedia asked us to wait · placing edits again in ${Math.ceil(pausedMs / 1000)} s`;
  if (behindMs > 20e3) return `placing edits about ${Math.round(behindMs / 1000)} s late`;
  return '';
}

// ---------------- controls ----------------
// Which wikis: ?wikis=en|top|all (not saved in the browser).
state.mode = urlParam('wikis', ['en', 'top', 'all']) || DEFAULTS.wikis;
$('wiki-mode').value = state.mode;
$('wiki-mode').onchange = e => { state.mode = e.target.value; setUrlParam('wikis', state.mode, DEFAULTS.wikis); };
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
let skyRotate = !motion.reduce;
WikiSky.setRotate(skyRotate);
watchHover($('sky'), WikiSky.globe, '.skym', on => WikiSky.setHovering(on)); // hold still over the sky sphere
setRotateButton($('rot-earth'), state.rotate);
setRotateButton($('rot-sky'), skyRotate);
$('rot-earth').onclick = () => {
  state.rotate = !state.rotate;
  applyRotation();
  setRotateButton($('rot-earth'), state.rotate);
};
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
  if (state.follow && latest && !state.selected) followNow(latest);
};
$('t-pause').onchange = e => { state.paused = e.target.checked; state.paused ? disconnect() : resume(); };
$('t-sound').onchange = e => {
  state.sound = e.target.checked;
  state.sound ? WikiSound.enable() : WikiSound.disable();
};

// Point style and bar height: button groups in the legend, kept in the address.
$('point-style').addEventListener('click', e => { const b = e.target.closest('button[data-style]'); if (b) setPointStyle(b.dataset.style); });
function setBarMetric(metric) {
  state.barMetric = metric === 'bytes' ? 'bytes' : 'count';
  for (const b of $('bar-metric').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.metric === state.barMetric));
  setUrlParam('height', state.barMetric === 'bytes' ? 'bytes' : 'edits', DEFAULTS.height); // ?height=bytes
}
$('bar-metric').addEventListener('click', e => {
  const b = e.target.closest('button[data-metric]');
  if (b) { setBarMetric(b.dataset.metric); buildGroups(); }
});
// From the address, else DEFAULTS.
setBarMetric(urlParam('height', ['edits', 'bytes']) || DEFAULTS.height);
setPointStyle(urlParam('points', ['markers', 'bars', 'heatmap']) || DEFAULTS.points); // ?points=markers

WikiSky.onSelect = item => select(item);

// Hidden tab: stop both globes' render loops and refresh everything when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    world.pauseAnimation();
    WikiSky.globe.pauseAnimation();
  } else {
    world.resumeAnimation();
    if (view.sky) WikiSky.globe.resumeAnimation();
    flags.windowDirty = true;
    flags.dirty = true;
  }
});
// Reduced motion: apply now, and follow the setting if it changes while the page is open.
WikiSky.setReducedMotion(motion.reduce);
if (motionQuery && motionQuery.addEventListener) {
  motionQuery.addEventListener('change', e => {
    motion.reduce = e.matches;
    WikiSky.setReducedMotion(motion.reduce);
    if (motion.reduce) state.rings = [];
  });
}

// ?simulate=Title|Title adds simulated edits to those articles shortly after loading.
const sim = new URLSearchParams(location.search).get('simulate');
if (sim) sim.split('|').forEach((t, i) => setTimeout(() => simulate(t.trim()), 1500 + i * 700));

connect();
// Turn animations on once the starting layout has been drawn (the timer covers tabs opened in the background).
const booted = () => document.body.classList.remove('booting');
requestAnimationFrame(() => requestAnimationFrame(booted));
setTimeout(booted, 1000);
window.__wikiSpace = { state, world, simulate }; // handy for debugging in the console, and used by the tests

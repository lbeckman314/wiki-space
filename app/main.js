// Start-up: wires the controls, runs the update loops and connects to the live stream.
// The other modules only declare things when they load; everything that touches the page starts here.
import { $, RING_LIFE, LABEL_LIFE, motionQuery, motion, state, flags, view, DEFAULTS, urlParam, setUrlParam } from './core.js';
import { world, initGlobe, applyRotation, followTo, watchHover } from './globe.js';
import { initPoints, buildGroups, setPointStyle, zoomChanged } from './points.js';
import { computeWindow } from './history.js';
import { connect, disconnect, isConnected, setStatus, simulate } from './stream.js';
import { initSidebar } from './sidebar.js';
import { initCard, select } from './card.js';
import { initApiPanel } from './apipanel.js';
import { WikiSky, initSky } from './sky.js';
import { WikiGeo } from './geo.js';

initSky();
initGlobe();
initPoints();
initSidebar();
initCard();
initApiPanel();

// ---------------- update loops ----------------
// The Earth's layers, four times a second, redrawing only what changed.
let lastWindow = 0;
setInterval(() => {
  if (document.hidden) return; // nothing to draw; the flags wait until the tab is back
  const now = Date.now();
  const ringCount = state.rings.length;
  state.rings = state.rings.filter(r => now - r.born < RING_LIFE);
  for (const l of state.labels) l.el.classList.toggle('fading', now - l.born > LABEL_LIFE - 800);

  // Which edits are on screen: when history changes, and once a second so old ones drop off.
  const windowChanged = flags.windowDirty || now - lastWindow > 1000;
  if (windowChanged) { computeWindow(); lastWindow = now; }
  if (windowChanged || flags.dirty || zoomChanged(world.pointOfView().altitude)) buildGroups();
  if (flags.dirty || ringCount !== state.rings.length) world.ringsData(state.rings.slice());
  // Titles are re-sent only when one is added: re-sending re-attaches their elements.
  if (flags.labelsDirty) world.htmlElementsData(state.labels.slice());
  flags.labelsDirty = flags.dirty = false;
}, 250);
setInterval(buildGroups, 5000); // markers fade as they age

// The tab counts and the status line, once a second.
setInterval(() => {
  const cutoff = Date.now() - 60e3;
  while (state.considered.length && state.considered[0] < cutoff) state.considered.shift();
  $('n-placed').textContent = state.placed.toLocaleString();
  $('n-unplaced').textContent = state.unplaced.toLocaleString();
  if (isConnected()) {
    const delay = lookupDelay();
    setStatus(delay ? '' : 'live', delay ? 'live · ' + delay : 'live from Wikipedia');
  }
}, 1000);

// Short waits are routine; only mention ones people would notice.
function lookupDelay() {
  const { pausedMs, behindMs } = WikiGeo.lookupStatus();
  if (pausedMs > 10e3) return `Wikipedia asked us to wait · placing edits again in ${Math.ceil(pausedMs / 1000)} s`;
  if (behindMs > 20e3) return `placing edits about ${Math.round(behindMs / 1000)} s late`;
  return '';
}

// ---------------- controls ----------------
// Which wikis (?wikis=en|top|all).
state.mode = urlParam('wikis', ['en', 'top', 'all']) || DEFAULTS.wikis;
$('wiki-mode').value = state.mode;
$('wiki-mode').onchange = e => {
  state.mode = e.target.value;
  setUrlParam('wikis', state.mode, DEFAULTS.wikis);
};

$('t-approx').onchange = e => {
  state.showApprox = e.target.checked;
  buildGroups();
};

// Follow (?follow=0 turns it off).
function setFollow(on) {
  state.follow = on;
  $('t-follow').checked = on;
  applyRotation();
  WikiSky.setFollow(on);
  const latest = state.points[state.points.length - 1];
  if (on && latest && !state.selected) followTo(latest, true);
  setUrlParam('follow', on ? '1' : '0', DEFAULTS.follow ? '1' : '0');
}
$('t-follow').onchange = e => setFollow(e.target.checked);
const followParam = urlParam('follow', ['0', '1']);
setFollow(followParam ? followParam === '1' : DEFAULTS.follow);

// Bars or markers (?points=markers).
$('point-style').addEventListener('click', e => {
  const b = e.target.closest('button[data-style]');
  if (b) setPointStyle(b.dataset.style);
});
setPointStyle(urlParam('points', ['markers', 'bars']) || DEFAULTS.points);

// The sky map: turns slowly, holds still under the mouse, and opens edits in the card.
WikiSky.setRotate(!motion.reduce);
watchHover($('sky'), WikiSky.globe, '.skym', on => WikiSky.setHovering(on));
WikiSky.onSelect = item => select(item);

// ---------------- the page around it ----------------
// Hidden tab: stop drawing both globes, and catch up when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    world.pauseAnimation();
    WikiSky.globe.pauseAnimation();
  } else {
    world.resumeAnimation();
    if (view.sky) WikiSky.globe.resumeAnimation();
    flags.windowDirty = flags.dirty = true;
  }
});

// Reduced motion: apply it now, and follow the setting if it changes while the page is open.
WikiSky.setReducedMotion(motion.reduce);
motionQuery.addEventListener('change', e => {
  motion.reduce = e.matches;
  state.rotate = !e.matches;
  applyRotation();
  WikiSky.setReducedMotion(motion.reduce);
  WikiSky.setRotate(state.rotate);
  if (motion.reduce) state.rings = [];
});

// ?simulate=Title|Title adds simulated edits to those articles shortly after loading.
const toSimulate = new URLSearchParams(location.search).get('simulate');
if (toSimulate) toSimulate.split('|').forEach((t, i) => setTimeout(() => simulate(t.trim()), 1500 + i * 700));

connect();

// Turn on animations once the first layout is drawn (the timer covers tabs opened in the background).
const booted = () => document.body.classList.remove('booting');
requestAnimationFrame(() => requestAnimationFrame(booted));
setTimeout(booted, 1000);

// For debugging in the console, and for the tests.
window.__wikiSpace = { state, world, sky: WikiSky, simulate, disconnect };

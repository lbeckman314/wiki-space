// The detail card in the sidebar: one edit's details, the additions/removals chart for its cluster,
// and the other edits in the same cluster.
import { $, POINT_LIFE, COLORS, BAR_ADD, BAR_REMOVE, esc, rgba, fmtRA, fmtDec, fmtDelta, fmtClock, glide, state, flags, view, tl, clockNow } from './core.js';
import { world, applyRotation } from './globe.js';
import { buildGroups, groupOf } from './points.js';
import { computeWindow } from './timeline.js';
import { setView } from './sidebar.js';

export function select(item) {
  state.selected = item;
  flags.listDirty = true; // highlight it in the list
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
    world.pointOfView({ lat: item.lat, lng: item.lng, altitude: Math.min(world.pointOfView().altitude, 1.6) }, glide(900));
  }
  renderAlsoHere(item);

  const base = `https://${item.server}`;
  const path = encodeURIComponent(item.title.replace(/ /g, '_'));
  $('card').hidden = false;
  renderChart(item); // after the card is visible, so the chart can measure its width
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

// Small chart in the card: additions (up) and removals (down) in this marker, in 30-second steps
// over the 10 minutes before the playhead. Only shown when the marker holds 2 or more edits.
function renderChart(item) {
  const box = $('card-chart');
  const g = !item.sky && !item.unplaced && groupOf(item);
  if (!g || g.n < 2) { box.hidden = true; return; }
  const T = clockNow(), N = 20, step = POINT_LIFE / N, start = T - POINT_LIFE;
  const add = new Array(N).fill(0), rem = new Array(N).fill(0);
  for (const p of g.items) {
    const i = Math.min(N - 1, Math.max(0, Math.floor((p.time - start) / step)));
    if (p.kind === 'add' || p.kind === 'new') add[i]++;
    else if (p.kind === 'remove') rem[i]++;
  }
  const A = add.reduce((a, b) => a + b, 0), R = rem.reduce((a, b) => a + b, 0);
  box.hidden = false;
  box.innerHTML =
    `<h4>Edits ${g.exact ? 'nearby' : 'at this place'} · last 10 minutes</h4>` +
    `<div class="chart-legend"><span><i style="--c:${rgba(BAR_ADD, 1)}"></i>${A} addition${A === 1 ? '' : 's'}</span>` +
    `<span><i style="--c:${rgba(BAR_REMOVE, 1)}"></i>${R} removal${R === 1 ? '' : 's'}</span></div>` +
    `<div class="chart-wrap"><canvas role="img" aria-label="${A} additions and ${R} removals in the last 10 minutes"></canvas><div class="chart-tip" hidden></div></div>` +
    `<div class="chart-axis"><span>10 min earlier</span><span>${tl.live ? 'now' : fmtClock(T)}</span></div>`;
  const wrapEl = box.querySelector('.chart-wrap'), canvas = box.querySelector('canvas'), tip = box.querySelector('.chart-tip');
  const dpr = window.devicePixelRatio || 1, w = wrapEl.clientWidth, h = 64, mid = h / 2;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const max = Math.max(1, ...add, ...rem), slot = w / N, bw = Math.max(2, slot - 2); // 2px gap between bars
  const bar = (x, y, bh, up) => {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, bw, bh, up ? [2, 2, 0, 0] : [0, 0, 2, 2]); else c.rect(x, y, bw, bh);
    c.fill();
  };
  for (let i = 0; i < N; i++) {
    const x = i * slot + 1;
    if (add[i]) { const bh = (mid - 3) * add[i] / max; c.fillStyle = rgba(BAR_ADD, 1); bar(x, mid - 1 - bh, bh, true); }
    if (rem[i]) { const bh = (mid - 3) * rem[i] / max; c.fillStyle = rgba(BAR_REMOVE, 1); bar(x, mid + 1, bh, false); }
  }
  c.fillStyle = 'rgba(255,255,255,0.22)';
  c.fillRect(0, mid - 0.5, w, 1); // baseline
  // Hover: the time span and counts for one 30-second step.
  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    const i = Math.min(N - 1, Math.max(0, Math.floor((e.clientX - r.left) / slot)));
    const t0 = start + i * step;
    tip.textContent = `${fmtClock(t0)}–${fmtClock(t0 + step)} · ${add[i]} addition${add[i] === 1 ? '' : 's'}, ${rem[i]} removal${rem[i] === 1 ? '' : 's'}`;
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(0, i * slot + slot / 2 - tip.offsetWidth / 2), w - tip.offsetWidth) + 'px';
  };
  canvas.onmouseleave = () => { tip.hidden = true; };
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

export function initCard() {
  $('card-close').onclick = () => {
    $('card').hidden = true;
    state.selected = null;
    flags.listDirty = true;
    WikiSky.focus(null);
    computeWindow();
    buildGroups();
    applyRotation();
  };
}

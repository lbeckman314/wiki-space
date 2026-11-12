// The detail card in the sidebar: one edit's details, a chart of additions and removals in its group,
// and the other edits in the same group.
import { $, POINT_LIFE, COLORS, esc, rgba, plural, fmtRA, fmtDec, fmtDelta, fmtClock, glide, state, flags, view } from './core.js';
import { world, applyRotation } from './globe.js';
import { buildGroups, groupOf } from './points.js';
import { computeWindow } from './history.js';
import { setView } from './sidebar.js';
import { WikiSky } from './sky.js';

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

export function select(item) {
  state.selected = item;
  flags.listDirty = true; // highlight it in the list
  if (!view.sidebar) setView('sidebar', true); // the card lives in the sidebar

  // Show it: on the sky map, or turn the Earth to it.
  WikiSky.focus(item.sky ? item : null);
  if (!item.sky && !item.unplaced) {
    computeWindow(); // keeps the selected edit on screen even when it's older than 10 minutes
    buildGroups();
    applyRotation();
    world.pointOfView({ lat: item.lat, lng: item.lng, altitude: Math.min(world.pointOfView().altitude, 1.6) }, glide(900));
  }

  $('card').hidden = false;
  fillDetails(item);
  renderChart(item); // after the card is visible, so the chart can measure its width
  renderOthers(item);
  loadSummary(item);
}

function fillDetails(item) {
  const site = `https://${item.server}`;
  const page = encodeURIComponent(item.title.replace(/ /g, '_'));
  $('card-lang').textContent = item.lang;
  $('card-time').textContent = new Date(item.time).toLocaleTimeString();
  $('card-title').textContent = item.title;
  $('card-title').href = `${site}/wiki/${page}`;
  $('card-where').innerHTML = whereText(item) +
    (item.qid ? ` · <a href="https://www.wikidata.org/wiki/${esc(item.qid)}" target="_blank" rel="noopener">${esc(item.qid)}</a>` : '');

  const cls = item.kind === 'new' ? 'newc' : item.delta > 0 ? 'pos' : item.delta < 0 ? 'neg' : '';
  $('card-delta').innerHTML = `<span class="${cls}">${item.kind === 'new' ? 'New article, ' : ''}${fmtDelta(item.delta)} bytes</span>`;
  $('card-user').textContent = item.user;
  $('card-user').href = `${site}/wiki/Special:Contributions/${encodeURIComponent(item.user)}`;
  $('card-comment').textContent = item.comment || '—';
  $('card-diff').href = item.revOld ? `${site}/w/index.php?diff=${item.revNew}&oldid=${item.revOld}` : `${site}/w/index.php?oldid=${item.revNew}`;
  $('card-diff').textContent = item.revOld ? 'View diff ↗' : 'View page revision ↗';
  $('card-diff').hidden = item.simulated;
}

function whereText(item) {
  const reason = esc(item.reason);
  if (item.unplaced) return `∅ <b>Not placed</b> · ${reason}`;
  if (item.sky) {
    const kind = item.tier === 'exact' ? 'Sky' : 'Sky, approximate';
    return `✦ <b>${kind}</b> · RA ${fmtRA(item.ra)}, Dec ${fmtDec(item.dec)} · ${reason}` + (item.distance ? ` · ${esc(item.distance)}` : '');
  }
  return (item.tier === 'exact' ? '📍 <b>Exact</b> · ' : '≈ <b>Approximate</b> · ') + reason;
}

// The article's first lines and picture, from Wikipedia's page summary.
function loadSummary(item) {
  $('card-extract').textContent = '';
  $('card-thumb').hidden = true;
  const url = `https://${item.server}/api/rest_v1/page/summary/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
  fetch(url)
    .then(r => (r.ok ? r.json() : null))
    .then(s => {
      if (!s || state.selected !== item) return; // another edit was opened meanwhile
      $('card-extract').textContent = s.extract || '';
      if (s.thumbnail && s.thumbnail.source) {
        $('card-thumb').src = s.thumbnail.source;
        $('card-thumb').hidden = false;
      }
    })
    .catch(() => {});
}

// Chart of additions (up) and removals (down) in the edit's group, in 30-second steps over the last
// 10 minutes. Only shown when the group holds 2 or more edits.
function renderChart(item) {
  const box = $('card-chart');
  const g = !item.sky && !item.unplaced && groupOf(item);
  if (!g || g.n < 2) { box.hidden = true; return; }

  const STEPS = 20, step = POINT_LIFE / STEPS, start = Date.now() - POINT_LIFE;
  const adds = new Array(STEPS).fill(0), removes = new Array(STEPS).fill(0);
  for (const p of g.items) {
    const i = Math.min(STEPS - 1, Math.max(0, Math.floor((p.time - start) / step)));
    if (p.kind === 'add' || p.kind === 'new') adds[i]++;
    else if (p.kind === 'remove') removes[i]++;
  }
  const totalAdds = adds.reduce((a, b) => a + b, 0), totalRemoves = removes.reduce((a, b) => a + b, 0);

  box.hidden = false;
  box.innerHTML = `
    <h4>Edits ${g.exact ? 'nearby' : 'at this place'} · last 10 minutes</h4>
    <div class="chart-legend">
      <span><i style="--c:${rgba(COLORS.add, 1)}"></i>${plural(totalAdds, 'addition')}</span>
      <span><i style="--c:${rgba(COLORS.remove, 1)}"></i>${plural(totalRemoves, 'removal')}</span>
    </div>
    <div class="chart-wrap">
      <canvas role="img" aria-label="${plural(totalAdds, 'addition')} and ${plural(totalRemoves, 'removal')} in the last 10 minutes"></canvas>
      <div class="chart-tip" hidden></div>
    </div>
    <div class="chart-axis"><span>10 min earlier</span><span>now</span></div>`;

  const canvas = box.querySelector('canvas'), tip = box.querySelector('.chart-tip');
  const w = box.querySelector('.chart-wrap').clientWidth, h = 64, mid = h / 2;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  const most = Math.max(1, ...adds, ...removes);
  const slot = w / STEPS, barW = Math.max(2, slot - 2); // 2px gap between bars
  const drawBar = (x, y, barH, up) => {
    c.beginPath();
    c.roundRect(x, y, barW, barH, up ? [2, 2, 0, 0] : [0, 0, 2, 2]);
    c.fill();
  };
  for (let i = 0; i < STEPS; i++) {
    const x = i * slot + 1;
    if (adds[i]) {
      const barH = ((mid - 3) * adds[i]) / most;
      c.fillStyle = rgba(COLORS.add, 1);
      drawBar(x, mid - 1 - barH, barH, true);
    }
    if (removes[i]) {
      const barH = ((mid - 3) * removes[i]) / most;
      c.fillStyle = rgba(COLORS.remove, 1);
      drawBar(x, mid + 1, barH, false);
    }
  }
  c.fillStyle = 'rgba(255,255,255,0.22)';
  c.fillRect(0, mid - 0.5, w, 1); // baseline

  // Hovering shows one step's time span and counts.
  canvas.onmousemove = e => {
    const i = Math.min(STEPS - 1, Math.max(0, Math.floor((e.clientX - canvas.getBoundingClientRect().left) / slot)));
    const t0 = start + i * step;
    tip.textContent = `${fmtClock(t0)}–${fmtClock(t0 + step)} · ${plural(adds[i], 'addition')}, ${plural(removes[i], 'removal')}`;
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(0, i * slot + slot / 2 - tip.offsetWidth / 2), w - tip.offsetWidth) + 'px';
  };
  canvas.onmouseleave = () => { tip.hidden = true; };
}

// The other edits in the same group, listed under the card.
function renderOthers(item) {
  const box = $('card-more');
  const g = !item.sky && !item.unplaced && groupOf(item);
  const others = g ? g.items.filter(p => p !== item).reverse() : [];
  box.hidden = !others.length;
  if (!others.length) return;

  box.innerHTML = `<h4>${plural(others.length, 'more edit')} ${g.exact ? 'nearby' : 'at this place'}</h4><ol></ol>`;
  const ol = box.querySelector('ol');
  for (const p of others.slice(0, 30)) {
    const li = document.createElement('li');
    const time = new Date(p.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<i class="sw" style="--c:${rgba(COLORS[p.kind], 1)}"></i><span class="t">${esc(p.title)}</span><span class="sub">${esc(p.lang)} · ${time}</span>`;
    li.onclick = () => select(p);
    ol.appendChild(li);
  }
  if (others.length > 30) ol.insertAdjacentHTML('beforeend', `<li class="more">+${others.length - 30} more</li>`);
}

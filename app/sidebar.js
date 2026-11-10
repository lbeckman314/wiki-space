// Sidebar list (tabs, filters, search), the stats links that filter it, and show/hide panels.
import { $, MAX_TICKER, COLORS, esc, rgba, fmtDelta, state, flags, view, load, save } from './core.js';
import { select } from './card.js';

// The list is rebuilt from the data (state.history / state.unplacedList), newest first, so search and
// filters cover everything recorded this session. Only the first MAX_TICKER matches are drawn.
const list = { tab: 'placed', filter: 'all', q: '', shown: [] };
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FILTERS = {
  all: () => true,
  exact: it => !it.sky && it.tier === 'exact',
  approx: it => !it.sky && it.tier !== 'exact',
  sky: it => !!it.sky,
};
const FILTER_NAMES = { all: 'placed', exact: 'exact', approx: 'approximate', sky: 'sky' };

function renderList() {
  flags.listDirty = false;
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

// ---------------- show / hide panels ----------------
const VIEW_KEY = 'wikiGlobe.view';
export function setView(part, on) {
  view[part] = on;
  document.body.classList.toggle('hide-' + part, !on);
  $('v-' + part).setAttribute('aria-pressed', String(on));
  if (part === 'sky') on ? WikiSky.globe.resumeAnimation() : WikiSky.globe.pauseAnimation(); // no drawing while hidden
  save(VIEW_KEY, JSON.stringify(view));
}

export function initSidebar() {
  // One click handler for all rows (rows are rebuilt often).
  $('ticker').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) select(list.shown[Number(li.dataset.i)]);
  });
  setInterval(() => { if (flags.listDirty) renderList(); }, 400);

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

  // Panels: restore the saved choice, then wire the toggles.
  try { Object.assign(view, JSON.parse(load(VIEW_KEY, '{}'))); } catch (e) { /* defaults */ }
  for (const part of Object.keys(view)) {
    $('v-' + part).onclick = () => setView(part, !view[part]);
    setView(part, view[part]);
  }
}

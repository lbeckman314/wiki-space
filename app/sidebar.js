// The sidebar: the list of edits (tabs, filters, search), showing and hiding panels, and resizing.
import { $, MAX_LIST, COLORS, esc, rgba, plural, fmtDelta, state, flags, view, DEFAULTS, urlParam, setUrlParam } from './core.js';
import { select } from './card.js';
import { WikiSky } from './sky.js';

export function initSidebar() {
  // One click handler for all rows, since rows are rebuilt often.
  $('ticker').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) select(list.shown[Number(li.dataset.i)]);
  });
  setInterval(() => { if (flags.listDirty) renderList(); }, 400);

  $('tab-placed').onclick = () => showTab('placed');
  $('tab-unplaced').onclick = () => showTab('unplaced');
  $('filters').addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]');
    if (b) setFilter(b.dataset.filter);
  });

  let searchTimer = null;
  $('search').addEventListener('input', e => {
    list.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 120);
  });
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.value = list.q = ''; renderList(); }
  });

  // Panels: from the address, else the defaults; each chevron toggles its panel.
  for (const part of Object.keys(view)) {
    const fromUrl = urlParam(part, ['0', '1']);
    if (fromUrl) view[part] = fromUrl === '1';
    $('toggle-' + part).onclick = () => setView(part, !view[part]);
    setView(part, view[part]);
  }
  initResize();
}

// ---------------- the list ----------------
// Rebuilt from state.history / state.unplacedList, newest first, so search and filters cover everything
// recorded this session. Only the first MAX_LIST matches are drawn.
const list = { tab: 'placed', filter: 'all', q: '', shown: [] };
const FILTERS = {
  all:    { name: 'placed',      test: () => true },
  exact:  { name: 'exact',       test: it => !it.sky && it.tier === 'exact' },
  approx: { name: 'approximate', test: it => !it.sky && it.tier !== 'exact' },
  sky:    { name: 'sky',         test: it => !!it.sky },
};
// Lower case without accents, so "sao paulo" finds "São Paulo".
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function renderList() {
  flags.listDirty = false;
  const placedTab = list.tab === 'placed';
  const source = placedTab ? state.history : state.unplacedList;
  const filter = placedTab ? FILTERS[list.filter] : FILTERS.all;
  const terms = fold(list.q).split(/\s+/).filter(Boolean);

  const shown = [];
  let matches = 0;
  for (let i = source.length - 1; i >= 0; i--) {
    const it = source[i];
    if (!filter.test(it)) continue;
    it.searchText ??= fold(`${it.title} ${it.lang} ${it.reason} ${it.user}`);
    if (!terms.every(t => it.searchText.includes(t))) continue;
    matches++;
    if (shown.length < MAX_LIST) shown.push(it);
  }
  list.shown = shown;
  $('ticker').innerHTML = shown.map(rowHtml).join('');

  // A note above the list, when there's something worth saying.
  const kind = placedTab ? filter.name : 'unplaced';
  const q = esc(list.q.trim());
  let note = '';
  if (!source.length) note = `No ${kind} edits yet.`;
  else if (!matches) note = `No ${kind} edits match “${q}”.`;
  else if (terms.length || list.filter !== 'all') {
    note = plural(matches, `${kind} edit`) + (terms.length ? ` matching “${q}”` : '') + (matches > shown.length ? ` · newest ${shown.length} shown` : '');
  } else if (matches > shown.length) note = `Newest ${shown.length} of ${matches.toLocaleString()} · search to find older ones`;
  $('list-note').innerHTML = note;
  $('list-note').hidden = !note;
}

function rowHtml(item, i) {
  const cls = item.kind === 'new' ? 'newc' : item.delta > 0 ? 'pos' : item.delta < 0 ? 'neg' : '';
  const icon = item.unplaced ? '∅' : item.sky ? '✦' : item.tier === 'exact' ? '📍' : '≈';
  const faint = item.tier === 'exact' || item.sky ? '' : 'opacity:.55';
  return `<li data-i="${i}"${item === state.selected ? ' class="sel"' : ''}>` +
    `<i class="sw" style="--c:${rgba(COLORS[item.kind], 1)};${faint}"></i>` +
    `<span class="t">${esc(item.title)}<span class="sub">${esc(item.lang)} · ${icon} ${esc(item.reason)}</span></span>` +
    `<span class="d ${cls}">${item.kind === 'new' ? 'new' : fmtDelta(item.delta)}</span></li>`;
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

// ---------------- showing and hiding panels ----------------
// Each panel has one chevron that stays in place and turns to point where the panel goes.
const PANEL_NAMES = { sidebar: 'the sidebar', sky: 'the sky map' };
export function setView(part, on) {
  view[part] = on;
  document.body.classList.toggle('hide-' + part, !on);
  const btn = $('toggle-' + part);
  btn.setAttribute('aria-expanded', String(on));
  btn.title = (on ? 'Hide ' : 'Show ') + PANEL_NAMES[part];
  btn.setAttribute('aria-label', btn.title);
  if (part === 'sky') on ? WikiSky.globe.resumeAnimation() : WikiSky.globe.pauseAnimation(); // no drawing while folded
  setUrlParam(part, on ? '1' : '0', DEFAULTS[part] ? '1' : '0');
}

// ---------------- resizing ----------------
// Drag the sidebar's edge (left edge on desktop, top edge on phones), or focus it and use the arrow keys.
// Double-click or Home goes back to the default size. The size isn't saved.
const phone = matchMedia('(max-width: 760px)');
function initResize() {
  const panel = $('panel'), handle = $('panel-resize');
  const sizeVar = () => (phone.matches ? '--panel-h' : '--panel-w');
  const size = () => (phone.matches ? panel.offsetHeight : panel.offsetWidth);
  // Leave some of the globe in view.
  const limits = () => phone.matches
    ? { min: 120, max: Math.max(120, innerHeight - 240) }
    : { min: 280, max: Math.max(280, Math.min(innerWidth - 320, 900)) };

  const describe = () => {
    const { min, max } = limits();
    handle.setAttribute('aria-orientation', phone.matches ? 'horizontal' : 'vertical');
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);
    handle.setAttribute('aria-valuenow', Math.round(size()));
  };
  const resizeTo = px => {
    const { min, max } = limits();
    panel.style.setProperty(sizeVar(), Math.round(Math.min(max, Math.max(min, px))) + 'px');
    describe();
  };
  const reset = () => {
    panel.style.removeProperty('--panel-w');
    panel.style.removeProperty('--panel-h');
    describe();
  };

  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, size: size() };
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', e => {
    // The panel grows as its edge moves away from it: left on desktop, up on phones.
    if (drag) resizeTo(drag.size + (phone.matches ? drag.y - e.clientY : drag.x - e.clientX));
  });
  const endDrag = () => { drag = null; document.body.classList.remove('resizing'); };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', e => {
    const step = e.shiftKey ? 80 : 20;
    const grow = phone.matches ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowLeft: 1, ArrowRight: -1 };
    if (e.key in grow) { e.preventDefault(); resizeTo(size() + grow[e.key] * step); }
    else if (e.key === 'Home') { e.preventDefault(); reset(); }
  });
  // Keep a dragged size inside the window when it shrinks; switching between phone and desktop layouts resets it.
  addEventListener('resize', () => (panel.style.getPropertyValue(sizeVar()) ? resizeTo(size()) : describe()));
  phone.addEventListener('change', reset);
  describe();
}

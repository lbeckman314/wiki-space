// The API panel: opens from the status line and shows the edit stream and place lookups (pace, rate limits,
// waiting batches, each server, recent requests). Refreshes once a second while open.
import { $, esc, state } from './core.js';
import { streamDetails } from './stream.js';

const WIKIMEDIA_LIMIT = 80; // per IP address per minute, across all Wikimedia sites (measured, 2026; may change)
const WIKIS = { en: 'English Wikipedia', top: 'Top 20 Wikipedias', all: 'All Wikipedias' };
let open = false;

const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const secs = ms => (ms < 60e3 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60e3) + ' min');
const n = v => Number(v).toLocaleString();
const shortHost = h => h.replace('.wikipedia.org', ' Wikipedia').replace('www.wikidata.org', 'Wikidata');

function meter(value, max) {
  const pct = Math.min(100, Math.round((100 * value) / max));
  return `<span class="api-meter${pct >= 80 ? ' warn' : ''}"><i style="width:${pct}%"></i></span>`;
}

function render() {
  const s = streamDetails();
  const g = WikiGeo.lookupDetails();
  const conn = s.paused ? 'Paused (Pause stream is on)'
    : s.state === 'closed' ? 'Reconnecting…'
    : (s.state === 'catching-up' ? 'Catching up on missed edits' : 'Connected') +
      (s.connectedAt ? ` · since ${clock(s.connectedAt)} (${secs(Date.now() - s.connectedAt)})` : '');

  const waitingItems = g.waiting.reduce((t, w) => t + w.items, 0);
  const wait = g.pausedMs > 0
    ? `<b>Wikipedia asked us to wait</b> · ${secs(g.pausedMs)} left`
    : g.inflight ? `Running · ${g.inflight} request${g.inflight > 1 ? 's' : ''} in flight` : 'Running';
  const limited = g.rateLimited
    ? `${n(g.rateLimited)} this session · last at ${clock(g.last429.at)} from ${esc(shortHost(g.last429.host))}` +
      (g.last429.retryAfter ? `, asked to wait ${secs(g.last429.retryAfter)}` : '')
    : 'None this session';

  const hostRows = g.hosts.map(h => `<tr><td>${esc(shortHost(h.host))}</td><td>${n(h.lastMin)}</td><td>${n(h.requests)}</td>` +
    `<td>${h.perRequest}</td><td>${n(h.avgMs)} ms</td><td>${h.rateLimited ? n(h.rateLimited) : '–'}</td><td>${h.errors ? n(h.errors) : '–'}</td></tr>`).join('');
  const waitRows = g.waiting.slice(0, 6).map(w => `<li><span>${esc(shortHost(w.label))}</span><span>${n(w.items)} · ${secs(w.ageMs)}</span></li>`).join('');
  const recentRows = g.recent.map(r => `<li><span class="t">${clock(r.at)}</span><span>${esc(shortHost(r.host))}</span>` +
    `<span class="st${r.status === 200 ? '' : ' bad'}">${esc(r.status)}</span><span>${n(r.n)} · ${n(Math.round(r.ms))} ms</span></li>`).join('');

  $('api-panel').innerHTML = `
    <div class="api-head"><h2>Edit stream and lookups</h2><button class="icon-btn" id="api-close" aria-label="Close">×</button></div>
    <h3>Edit stream</h3>
    <dl>
      <dt>Connection</dt><dd>${conn}${s.drops ? ` · dropped ${n(s.drops)}×` : ''}</dd>
      <dt>Events</dt><dd>${n(s.eventsLastMin)} in the last minute, all wikis · ${n(state.considered.length)} article edits kept</dd>
      <dt>Watching</dt><dd>${WIKIS[state.mode] || esc(state.mode)}</dd>
    </dl>
    <h3>Place lookups</h3>
    <dl>
      <dt>Status</dt><dd>${wait}</dd>
      <dt>Pace</dt><dd>${meter(g.sentLastMin, WIKIMEDIA_LIMIT)} ${n(g.sentLastMin)} requests in the last minute.
        We send at most ${g.pacePerMin} a minute${g.hidden ? ' while this tab is in the background' : ` (${g.hiddenPacePerMin} in a background tab)`}. Wikimedia allows about ${WIKIMEDIA_LIMIT} per IP address, shared with your other tabs.</dd>
      <dt>Rate-limited</dt><dd>${limited}</dd>
      <dt>Waiting</dt><dd>${waitingItems ? `${n(waitingItems)} lookups in ${g.waiting.length} batch${g.waiting.length > 1 ? 'es' : ''} · oldest ${secs(g.behindMs)}` : 'Nothing waiting'}
        ${waitRows ? `<ul class="api-list">${waitRows}</ul>` : ''}</dd>
    </dl>
    ${hostRows ? `<h3>Servers</h3>
    <table class="api-table"><thead><tr><th>Server</th><th title="Requests in the last minute">1 min</th><th>Total</th>
      <th title="Articles or items per request">Per req.</th><th>Avg time</th><th title="HTTP 429: asked to wait">Limited</th><th>Errors</th></tr></thead>
      <tbody>${hostRows}</tbody></table>` : ''}
    ${recentRows ? `<h3>Recent requests</h3><ul class="api-list api-recent">${recentRows}</ul>` : ''}
    <p class="api-note">Counts since ${clock(g.since)}. Article summaries in the card aren't counted.</p>`;
  $('api-close').onclick = () => setOpen(false);
}

function setOpen(on) {
  open = on;
  $('api-panel').hidden = !on;
  $('status').setAttribute('aria-expanded', String(on));
  if (on) render();
}

export function initApiPanel() {
  $('status').onclick = () => setOpen(!open);
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { setOpen(false); $('status').focus(); } });
  document.addEventListener('pointerdown', e => {
    if (open && !e.target.closest('#api-panel, #status')) setOpen(false);
  });
  setInterval(() => { if (open && !document.hidden) render(); }, 1000);
}

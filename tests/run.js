// Wiki Space browser tests.
//
//   npm install          (once: installs Playwright)
//   npx playwright install chromium   (once, if you don't already have Playwright's Chromium)
//   npm test
//
// Starts a small static server for the project folder, opens the page in headless Chromium and checks
// the main features using simulated edits at fixed locations, so no Wikipedia or Wikidata lookups are
// made. The page still loads its libraries and textures from jsDelivr, so it needs internet access.
// Software-rendered browsers draw slowly, so checks poll instead of waiting fixed times.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.md': 'text/plain' };

let failures = 0, passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Poll fn() in the page until it returns a truthy value or the timeout passes.
async function waitFor(page, fn, arg, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

async function openPage(browser, base, { viewport = { width: 1400, height: 850 }, reducedMotion = 'no-preference', query = '' } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + '/' + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(page, () => !!window.__wikiSpace);
  // Stop the live stream so only simulated edits appear.
  await page.evaluate(() => { const p = document.getElementById('t-pause'); if (!p.checked) p.click(); });
  return page;
}

const sim = (page, title, at, lang = 'en') => page.evaluate(([t, a, l]) => __wikiSpace.simulate(t, l, a), [title, at, lang]);
const rows = page => page.evaluate(() => [...document.querySelectorAll('#ticker li .t')].map(e => e.firstChild.textContent));

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' };
  const browser = await chromium.launch(launch);

  try {
    console.log('Placing, clustering and the sidebar');
    {
      const page = await openPage(browser, base);
      for (let i = 0; i < 5; i++) await sim(page, 'Paris edit ' + i, { lat: 48.85 + i * 0.01, lng: 2.35 });
      for (let i = 0; i < 4; i++) await sim(page, 'US topic ' + i, { lat: 39.8, lng: -98.6, tier: 'country', reason: 'Country: United States' });
      await sim(page, 'Andromeda Galaxy', { sky: true, ra: 10.68, dec: 41.27 });
      await sim(page, 'Essay', { unplaced: true, reason: 'No coordinates, and no related place on Wikidata' });
      await page.evaluate(() => __wikiSpace.world.pointOfView({ lat: 45, lng: -40, altitude: 2.4 }));
      const groups = await waitFor(page, () => {
        const g = __wikiSpace.state.groups;
        return g.reduce((n, x) => n + x.n, 0) >= 9 && g.map(x => `${x.exact ? 'exact' : 'approx'}:${x.n}`).sort().join(' ');
      });
      check('nearby edits merge into clusters', groups === 'approx:4 exact:5', groups);
      check('sky edit goes to the sky map', await page.evaluate(() => __wikiSpace.state.sky === 1));
      const listed = await waitFor(page, () => document.querySelectorAll('#ticker li .t').length === 10); // the list redraws every 0.4 s
      check('placed list shows all placed edits', !!listed, `rows: ${await page.evaluate(() => document.querySelectorAll('#ticker li .t').length)}`);
      await page.click('#stats button[data-filter="approx"]');
      check('"approximate" stat filters the list', JSON.stringify(await rows(page)) === JSON.stringify(['US topic 3', 'US topic 2', 'US topic 1', 'US topic 0']));
      await page.click('#filters button[data-filter="all"]');
      await page.fill('#search', 'andromeda');
      // Poll: the search is debounced and the list redraws on a timer, which can lag on slow machines.
      await waitFor(page, () => document.querySelectorAll('#ticker li').length === 1, null, 10000);
      const found = JSON.stringify(await rows(page));
      check('search finds by title', found === '["Andromeda Galaxy"]', found);
      await page.fill('#search', '');
      await page.click('#tab-unplaced');
      await page.waitForTimeout(400);
      check('unplaced tab lists unplaced edits', JSON.stringify(await rows(page)) === '["Essay"]');
      await page.click('#tab-placed');
      await page.waitForTimeout(400);
      await page.evaluate(() => [...document.querySelectorAll('#ticker li')].find(li => li.textContent.includes('Paris edit 4')).click());
      const card = await waitFor(page, () => !document.getElementById('card').hidden && !document.getElementById('card-chart').hidden && document.getElementById('card-title').textContent);
      check('clicking a row opens the card with the cluster chart', card === 'Paris edit 4', String(card));
      check('card lists the other edits in the cluster', await page.evaluate(() => document.querySelectorAll('#card-more li').length === 4));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    console.log('Point styles');
    {
      const page = await openPage(browser, base);
      for (let i = 0; i < 6; i++) await sim(page, 'Add ' + i, { lat: 51.5, lng: -0.12 });
      await page.evaluate(() => { // make three of them removals
        __wikiSpace.state.history.slice(0, 3).forEach(h => { h.kind = 'remove'; h.delta = -50; });
      });
      await page.click('#point-style [data-style=bars]');
      // Bars are the default, so wait for the pair rather than the first bars drawn (before the removals were marked).
      const bars = await waitFor(page, () => {
        const b = __wikiSpace.world.pointsData(), sides = b.every(x => x.bar) && b.map(x => x.side).sort().join(',');
        return sides === 'add,remove' ? sides : '';
      }) || await page.evaluate(() => __wikiSpace.world.pointsData().map(x => x.side).sort().join(','));
      check('bars style draws an additions bar and a removals bar', bars === 'add,remove', String(bars));
      await page.click('#point-style [data-style=heatmap]');
      const heat = await waitFor(page, () => { const h = __wikiSpace.world.heatmapsData(); return h.length === 1 && h[0].points.length > 0; });
      check('heatmap style feeds the heatmap layer', !!heat);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(page, () => !!window.__wikiSpace);
      check('point style stays (in the address) after a reload', await page.evaluate(() => document.querySelector('#point-style [data-style=heatmap]').getAttribute('aria-pressed') === 'true'));
      await page.click('#point-style [data-style=markers]');
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    console.log('History window');
    {
      const page = await openPage(browser, base);
      await page.evaluate(() => {
        const now = Date.now();
        for (let i = 0; i < 40; i++) __wikiSpace.simulate('Edit ' + i, 'en', { lat: 10, lng: i, time: now - (40 - i) * 45e3 });
      });
      const live = await waitFor(page, () => __wikiSpace.state.points.length > 0 && __wikiSpace.state.points.length);
      check('the globe shows only the last 10 minutes', live > 0 && live <= 14, String(live));
      check('older edits stay in history', await page.evaluate(() => __wikiSpace.state.history.length >= 40));
      check('no timeline bar', await page.evaluate(() => !document.getElementById('timeline') && !document.getElementById('toggle-timeline')));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    console.log('Resizing the sidebar');
    {
      const page = await openPage(browser, base);
      const before = await page.evaluate(() => document.getElementById('panel').offsetWidth);
      const h = await page.locator('#panel-resize').boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 - 150, h.y + 200, { steps: 4 });
      await page.mouse.up();
      const wide = await waitFor(page, () => document.getElementById('panel').offsetWidth);
      check('dragging the left edge widens the sidebar', Math.abs(wide - (before + 150)) <= 4, `${before} → ${wide}`);
      await page.focus('#panel-resize');
      await page.keyboard.press('ArrowRight');
      check('arrow keys resize it', await page.evaluate(w => document.getElementById('panel').offsetWidth === w - 20, wide));
      await page.dblclick('#panel-resize');
      check('double-click goes back to the default width', await page.evaluate(b => document.getElementById('panel').offsetWidth === b, before));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();

      const phone = await openPage(browser, base, { viewport: { width: 390, height: 800 } });
      const ph = await phone.evaluate(() => document.getElementById('panel').offsetHeight);
      const g = await phone.locator('#panel-resize').boundingBox();
      await phone.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await phone.mouse.down();
      await phone.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 120, { steps: 4 });
      await phone.mouse.up();
      const tall = await phone.evaluate(() => document.getElementById('panel').offsetHeight);
      check('phones: dragging the top edge makes the sidebar taller', Math.abs(tall - (ph + 120)) <= 4, `${ph} → ${tall}`);
      check('no page errors', phone.errors.length === 0, phone.errors.join(' | '));
      await phone.context().close();
    }

    console.log('Panels, follow and reduced motion');
    {
      const page = await openPage(browser, base);
      await page.click('#toggle-sidebar');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(page, () => !!window.__wikiSpace);
      check('hidden panels stay hidden after a reload', await page.evaluate(() =>
        document.getElementById('panel').offsetWidth === 0));
      await page.click('#toggle-sidebar');
      await page.evaluate(() => { const p = document.getElementById('t-pause'); if (!p.checked) p.click(); });
      await page.click('#t-follow');
      await sim(page, 'Sydney', { lat: -33.86, lng: 151.21 });
      const pov = await waitFor(page, () => { const v = __wikiSpace.world.pointOfView(); return Math.abs(v.lat + 33.86) < 0.5 && Math.abs(v.lng - 151.21) < 0.5; }, null, 20000);
      check('Follow turns the globe to the newest edit', !!pov);
      check('rotation pauses while following', await page.evaluate(() => __wikiSpace.world.controls().autoRotate === false));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();

      const calm = await openPage(browser, base, { reducedMotion: 'reduce' });
      check('reduced motion: globes start without rotation', await calm.evaluate(() =>
        __wikiSpace.world.controls().autoRotate === false && WikiSky.globe.controls().autoRotate === false));
      await sim(calm, 'Quiet edit', { lat: 0, lng: 0 });
      await calm.waitForTimeout(500);
      check('reduced motion: no ripples', await calm.evaluate(() => __wikiSpace.state.rings.length === 0));
      check('no page errors', calm.errors.length === 0, calm.errors.join(' | '));
      await calm.context().close();
    }

    console.log('Defaults and settings in the address');
    {
      const page = await openPage(browser, base);
      check('defaults: sidebar open, sky map folded, bars', await page.evaluate(() =>
        !document.body.classList.contains('hide-sidebar') && document.body.classList.contains('hide-sky') &&
        document.querySelector('#point-style [data-style=bars]').getAttribute('aria-pressed') === 'true'));
      check('defaults leave the address clean', await page.evaluate(() => location.search === ''), await page.evaluate(() => location.search));
      await page.click('#status');
      check('the status line opens the API panel', !!(await waitFor(page, () => {
        const p = document.getElementById('api-panel'); return !p.hidden && p.textContent.includes('Place lookups');
      })));
      await page.keyboard.press('Escape');
      check('Escape closes the API panel', await page.evaluate(() => document.getElementById('api-panel').hidden));
      await page.click('#toggle-sky');
      await page.click('#point-style [data-style=heatmap]');
      check('changing settings writes them to the address', await page.evaluate(() => {
        const q = new URLSearchParams(location.search); return q.get('sky') === '1' && q.get('points') === 'heatmap';
      }), await page.evaluate(() => location.search));
      // Nothing is kept in the browser: the plain address opens the defaults again in the same browser.
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await waitFor(page, () => !!window.__wikiSpace);
      check('a plain address opens the defaults, whatever was chosen before', await page.evaluate(() =>
        document.body.classList.contains('hide-sky') && __wikiSpace.state.pointStyle === 'bars' && location.search === ''));
      await page.context().close();

      const linked = await openPage(browser, base, { query: '?sidebar=0&sky=1&points=markers&height=bytes&wikis=en&points=bogus' });
      check('a link sets panels, point style, bar height and wikis', await linked.evaluate(() =>
        document.body.classList.contains('hide-sidebar') && !document.body.classList.contains('hide-sky') &&
        __wikiSpace.state.pointStyle === 'markers' && __wikiSpace.state.barMetric === 'bytes' && __wikiSpace.state.mode === 'en' &&
        document.getElementById('wiki-mode').value === 'en'));
      check('no page errors', linked.errors.length === 0, linked.errors.join(' | '));
      await linked.context().close();
    }

    console.log('About page');
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(base + '/about.html', { waitUntil: 'domcontentloaded' });
      check('About page loads', (await page.title()) === 'About Wiki Space');
      check('About page fits a phone screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

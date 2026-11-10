// Wiki Globe browser tests.
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

async function openPage(browser, base, { viewport = { width: 1400, height: 850 }, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(page, () => !!window.__wikiGlobe);
  // Stop the live stream so only simulated edits appear.
  await page.evaluate(() => { const p = document.getElementById('t-pause'); if (!p.checked) p.click(); });
  return page;
}

const sim = (page, title, at, lang = 'en') => page.evaluate(([t, a, l]) => __wikiGlobe.simulate(t, l, a), [title, at, lang]);
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
      await page.evaluate(() => __wikiGlobe.world.pointOfView({ lat: 45, lng: -40, altitude: 2.4 }));
      const groups = await waitFor(page, () => {
        const g = __wikiGlobe.state.groups;
        return g.length >= 2 && g.map(x => `${x.exact ? 'exact' : 'approx'}:${x.n}`).sort().join(' ');
      });
      check('nearby edits merge into clusters', groups === 'approx:4 exact:5', groups);
      check('sky edit goes to the sky map', await page.evaluate(() => __wikiGlobe.state.sky === 1));
      await page.waitForTimeout(600);
      check('placed list shows all placed edits', (await rows(page)).length === 10);
      await page.click('#stats button[data-filter="approx"]');
      check('"approximate" stat filters the list', JSON.stringify(await rows(page)) === JSON.stringify(['US topic 3', 'US topic 2', 'US topic 1', 'US topic 0']));
      await page.click('#filters button[data-filter="all"]');
      await page.fill('#search', 'andromeda');
      await page.waitForTimeout(400);
      check('search finds by title', JSON.stringify(await rows(page)) === '["Andromeda Galaxy"]');
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
        __wikiGlobe.state.history.slice(0, 3).forEach(h => { h.kind = 'remove'; h.delta = -50; });
      });
      await page.selectOption('#point-style', 'bars');
      const bars = await waitFor(page, () => { const b = __wikiGlobe.world.pointsData(); return b.length && b.every(x => x.bar) && b.map(x => x.side).sort().join(','); });
      check('bars style draws an additions bar and a removals bar', bars === 'add,remove', String(bars));
      await page.selectOption('#point-style', 'heatmap');
      const heat = await waitFor(page, () => { const h = __wikiGlobe.world.heatmapsData(); return h.length === 1 && h[0].points.length > 0; });
      check('heatmap style feeds the heatmap layer', !!heat);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(page, () => !!window.__wikiGlobe);
      check('point style is remembered after a reload', await page.evaluate(() => document.getElementById('point-style').value === 'heatmap'));
      await page.selectOption('#point-style', 'markers');
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    console.log('Timeline');
    {
      const page = await openPage(browser, base);
      await page.evaluate(() => {
        const now = Date.now();
        for (let i = 0; i < 40; i++) __wikiGlobe.simulate('Edit ' + i, 'en', { lat: 10, lng: i, time: now - (40 - i) * 45e3 });
      });
      const live = await waitFor(page, () => __wikiGlobe.state.points.length > 0 && __wikiGlobe.state.points.length);
      check('live view shows only the last 10 minutes', live > 0 && live <= 14, String(live));
      const box = await page.locator('#tl-track').boundingBox();
      await page.click('#tl-play'); // pause (freezes "now")
      await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
      // Wait for the result itself: pausing alone already shows "Go live", before the scrub lands.
      const replay = await waitFor(page, () => __wikiGlobe.state.points.length > 0 && __wikiGlobe.state.points[0].title === 'Edit 0');
      const shown = await page.evaluate(() => (__wikiGlobe.state.points[0] || {}).title);
      check('scrubbing back shows older edits', !!replay, `oldest shown: ${shown}`);
      await page.click('#tl-live');
      check('Live button returns to live', !!(await waitFor(page, () => document.getElementById('tl-live').textContent === 'Live')));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    console.log('Panels, follow and reduced motion');
    {
      const page = await openPage(browser, base);
      await page.click('#v-sidebar'); await page.click('#v-timeline');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(page, () => !!window.__wikiGlobe);
      check('hidden panels stay hidden after a reload', await page.evaluate(() =>
        getComputedStyle(document.getElementById('panel')).display === 'none' && getComputedStyle(document.getElementById('timeline')).display === 'none'));
      await page.click('#v-sidebar'); await page.click('#v-timeline');
      await page.evaluate(() => { const p = document.getElementById('t-pause'); if (!p.checked) p.click(); });
      await page.click('#t-follow');
      await sim(page, 'Sydney', { lat: -33.86, lng: 151.21 });
      const pov = await waitFor(page, () => { const v = __wikiGlobe.world.pointOfView(); return Math.abs(v.lat + 33.86) < 0.5 && Math.abs(v.lng - 151.21) < 0.5; }, null, 20000);
      check('Follow turns the globe to the newest edit', !!pov);
      check('rotation pauses while following', await page.evaluate(() => __wikiGlobe.world.controls().autoRotate === false));
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();

      const calm = await openPage(browser, base, { reducedMotion: 'reduce' });
      check('reduced motion: globes start without rotation', await calm.evaluate(() =>
        __wikiGlobe.world.controls().autoRotate === false && WikiSky.globe.controls().autoRotate === false));
      await sim(calm, 'Quiet edit', { lat: 0, lng: 0 });
      await calm.waitForTimeout(500);
      check('reduced motion: no ripples', await calm.evaluate(() => __wikiGlobe.state.rings.length === 0));
      check('no page errors', calm.errors.length === 0, calm.errors.join(' | '));
      await calm.context().close();
    }

    console.log('About page');
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(base + '/about.html', { waitUntil: 'domcontentloaded' });
      check('About page loads', (await page.title()) === 'About Wiki Globe');
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

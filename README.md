# Wiki Space

Live, non-bot edits to Wikipedia articles, shown on a 3D globe as they happen. Edits to astronomy articles (stars, galaxies, planets, asteroids) appear on a separate sky map. Everything runs in your browser; there's no server. Inspired by Hatnote's [Listen to Wikipedia](https://listen.hatnote.com/).

![Wiki Space: live English Wikipedia edits as bars on the globe, the sky map, and the list of recent edits](screenshot.png)

## Run it

It's a static site with no build step. Serve the folder with any web server (opening `index.html` as a file won't work, because browsers only load JavaScript modules from a server):

```bash
git clone https://github.com/lbeckman314/wiki-space.git
```

```bash
cd wiki-space && python3 -m http.server 8000
```

Then open http://localhost:8000. To publish it, copy the folder to any static host; GitHub Pages serves it straight from the `main` branch.

Astronomy edits are rare. To see the sky map straight away, simulate edits to chosen articles (this only reads from Wikipedia and Wikidata):

```
http://localhost:8000/?simulate=Andromeda Galaxy|Betelgeuse|Mars
```

In the browser console, `__wikiSpace.simulate(title, lang, at)` does the same. Pass a place to skip the lookup:

```js
__wikiSpace.simulate('Test edit', 'en', { lat: 48.86, lng: 2.29 })
__wikiSpace.simulate('Test star', 'en', { sky: true, ra: 88.79, dec: 7.41 })
```

## Reading the globe

- **Teal**: content added. **Orange-red**: content removed. **Purple**: a new article. (Chosen to stay distinguishable with red-green colour blindness.)
- Each edit ripples where it lands and shows its title for a few seconds. It stays on the globe for 10 minutes, fading as it ages.
- **Exact** places (the article's own coordinates) are solid; **approximate** ones (a related place, such as a person's birthplace or a country) are fainter.
- **✦ Sky**: astronomy articles go on the sky map instead (top right), at their position among the stars.

## Using it

- **Bars / Markers** (top of the legend): bars show additions (teal, left) and removals (orange-red, right) for each group of nearby edits; markers show one numbered disc per group. Groups split apart as you zoom in.
- **Follow** (on by default): turn each globe to its newest edit, at most every 1.5 seconds.
- **Approximate**: show or hide edits placed through a related place on Wikidata.
- **Wikis**: English Wikipedia (default), the 20 biggest languages, or all Wikipedias.
- **Click** a bar, marker, floating title or list entry to open its card: the article summary, the change, the editor and a link to the diff. For a group, the card also shows a chart of the last 10 minutes and the other edits in it. You don't need to hit a bar exactly: the nearest one within about 22 pixels (38 for a finger) lights up and opens.
- **Search** and the **All / Exact / Approximate / Sky** filters cover every edit recorded this session. The **Unplaced** tab lists edits that couldn't be placed, with the reason.
- **Chevrons** hide and show the sidebar and sky map. Drag the sidebar's edge to resize it (or focus it and use the arrow keys; double-click resets it).
- **GitHub icon** (next to the title): this repository.
- **Status line** (under the title): click it for the edit feed, the lookup pace, rate limits and each server.
- The globes turn slowly, and hold still while the mouse is over them. With the system's reduce-motion setting on, they don't turn, ripples are skipped and camera moves jump.

Settings live in the address, so a link opens exactly what you see: `?sidebar=0`, `?sky=1`, `?follow=0`, `?points=markers`, `?wikis=top` or `?wikis=all`. A plain address opens the defaults.

## How edits are placed

```
EventStreams ─► keep: article edits and new articles, not bots, on the chosen Wikipedias
        │
        ▼
geo.js  1. Wikipedia API (50 titles per request): the article's coordinates      → exact
        2. Wikidata (50 items per request):
             P625 coordinates                                                    → exact
             sky position (below)                                                → sky map
             first related place with coordinates:
               P276 location, P131 area, P159 HQ, P740 formed in                 → approximate
               P19 born in, P20 died in, P17 country, P495 origin, P27 citizen  → approximate
        3. nothing found                                                         → Unplaced
sky     Sun, Moon and planets: today's position (astronomy-engine)
        P6257 / P6258 right ascension and declination: stars, galaxies, nebulae
        orbital elements: today's position for asteroids and comets
        P59 constellation only: its centre (approximate)
```

Every answer is cached. Lookups go out through one queue, at most one request every 2 seconds (every 10 seconds in a background tab), because Wikimedia's limit (about 80 a minute) is shared by everything on your IP address. When Wikimedia asks the page to wait (HTTP 429), all lookups pause and the status line says so.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css` | Page layout and styles (the sidebar moves under the globe below 760px wide). The import map at the bottom of `index.html` pins globe.gl and astronomy-engine on jsDelivr |
| `app/geo.js` | Finds a place for each article: batching, caching, pacing, the Wikidata fallbacks |
| `app/sky.js` | The sky map, star and constellation data, and astronomy helpers |
| `app/main.js` | Start-up: controls, update loops, connecting to the feed |
| `app/core.js` | Constants, helpers, settings (`DEFAULTS`) and shared state |
| `app/stream.js` | The live feed, turning edits into items, `simulate()` |
| `app/history.js` | Every placed edit this session, and the 10 minutes shown on the Earth |
| `app/globe.js` | The Earth: layers, ripples, floating titles, Follow, rotation |
| `app/points.js` | Grouping nearby edits, bars and markers, and aiming help |
| `app/sidebar.js` | The list, search and filters, showing/hiding and resizing panels |
| `app/card.js` | The detail card and its chart |
| `app/apipanel.js` | The panel that opens from the status line |
| `tests/run.js` | Browser tests (Playwright): `npm install` and `npx playwright install chromium` once, then `npm test` |

## Credits and data

| What | Source | License |
|---|---|---|
| Live edits | [Wikimedia EventStreams](https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams) | Wikimedia terms of use |
| Article coordinates and summaries | Wikipedia (MediaWiki and REST APIs) | Text: CC BY-SA 4.0 |
| Places, sky coordinates and orbits | [Wikidata](https://www.wikidata.org/) | CC0 |
| 3D globes | [globe.gl](https://github.com/vasturiano/globe.gl), built on three.js | MIT |
| Earth images | three-globe example images, based on NASA imagery | See three-globe |
| Stars and constellations | [d3-celestial](https://github.com/ofrohn/d3-celestial) data | BSD-3-Clause |
| Planet positions | [Astronomy Engine](https://github.com/cosinekitty/astronomy) | MIT |
| Inspiration | [Listen to Wikipedia](https://listen.hatnote.com/) by Hatnote | – |

# Idea: Wiki Space as an SSH terminal app

Not implemented. Notes on how a terminal version could work, so people could connect with `ssh` and see a similar view.

## Addressing

ssh connects to a host, not a path, so `ssh liambeckman.com/wiki-space` won't work. Common patterns:

- `ssh wiki-space@liambeckman.com`: the server reads the username and picks the app (the usual choice for multi-app SSH servers).
- `ssh globe.liambeckman.com`: a subdomain per app.
- `ssh -t liambeckman.com wiki-space`: the command name picks the app.

If port 22 is already used for your own SSH login, either give the app port 22 and move the admin login to another port, or give the app its own IP or subdomain. Otherwise users need `ssh -p 2222 …`.

## Prior art

- `telnet mapscii.me`: a zoomable world map in the terminal, drawn with braille characters. The closest precedent.
- `ssh terminal.shop`, `ssh git.charm.sh`, `ssh sshtron.zachlatta.com`: interactive apps served over SSH.
- `telnet towel.blinkenlights.nl`: ASCII Star Wars.

## Stack

Go with Charm's **Wish** (SSH server library), **Bubble Tea** (terminal UI) and **Lip Gloss** (styling). Each connection gets its own UI session, with no shell and no authentication needed. Rust (russh + ratatui) is a good alternative.

## Architecture

```
Wikimedia stream ─► one server process: filter, look up locations once, cache, keep history
                        ├─► SSH sessions (terminal UI)
                        └─► WebSocket/SSE feed for the web page (optional)
```

- Each article's location is looked up once on the server, so viewers don't hit Wikimedia's rate limits.
- The server keeps history, so the timeline can cover a day or week for both the terminal and the web page.
- The resolver (article coordinates, then the Wikidata fallback chain, then sky coordinates) is ported once to Go and shared.

## Drawing in a terminal

- **Globe:** for each character cell, work out which latitude and longitude it shows on a rotating sphere and check a low-resolution land map. Braille characters give 2×4 dots per cell, so 80×40 cells make a 160×160-dot globe: coarse, but continents are recognisable. Rotate by changing the centre longitude each frame.
- **Edits:** truecolor markers (256-colour fallback), counts on clusters, ripples as expanding braille circles, titles where there's room.
- **Sky map:** the same projection with the star catalogue and constellation lines on the braille grid.
- **Timeline:** a sparkline (`▁▂▃▅▇`) with a playhead. `[` `]` to scrub, space to play, `+`/`-` for speed.
- **Interaction:** arrow keys to rotate, `+`/`-` to zoom, Tab between panels, Enter for the card. Mouse clicks work over SSH in most terminals. Clickable links (OSC 8) work in many terminals.
- **Frame rate:** about 5–10 frames per second. Bubble Tea redraws only changed lines, so bandwidth is a few KB per second per viewer.

## Compared with the web version

- No night-lights texture, only stylised shading. Sixel or kitty image protocols could add real images, but support over SSH is patchy, so treat it as an extra.
- No sound beyond the terminal bell.
- Small terminals (80×24) need an adaptive layout: globe only, or globe plus list.

## Running it publicly

- A small always-on server (for example a $5–10/month VPS). Per-viewer cost is small; measure capacity rather than assume it.
- No shell to break into with Wish, but still cap total and per-IP connections, add idle timeouts, and run the process unprivileged, ideally in a container.

## Effort (rough guesses)

- A weekend for a rotating braille globe with live markers and a list.
- A few weeks part-time for the sky map, clusters, timeline, mouse support and polish.

Build the server-side resolver and history store first: they also let the website's timeline cover days or weeks.

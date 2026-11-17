# SCPA Dispatch: live 911 monitor for Lancaster and neighboring counties

One dashboard for 911 activity in Lancaster, York, Chester, Lebanon and Cumberland counties. A small backend polls each county's public page (browsers can't fetch those directly because the counties send no CORS headers), normalizes everything into one feed, and caches it for 45 s so any number of open tabs cost each county one request per ~minute.

## Sources (verified against live pages 2026-11-17)

| County | Page | What it is | Parsed fields |
|---|---|---|---|
| Lancaster | `webcad.lcwc911.us/…/LiveIncidentsFeed.aspx` | Active-incident RSS | type, intersection, municipality, units, time |
| Chester | `webcad.chesco.org/WebCad/webcad.asp` | Active-incident tables (Fire / EMS / Traffic) | incident #, type, location, municipality, time, station |
| Cumberland | ArcGIS FeatureServer behind `gis.ccpa.net/incidents` | Active incidents, one row per unit | case #, type, street + cross streets, municipality, box, units, agencies, **exact lat/long** |
| York | `yorkfirepage.org/filter.html` | **Pager log** (decoded dispatch pages, last ~1000) | box, type, alarm level, place name, address, municipality, units, agency, **exact lat/long** |
| Lebanon | `lcdes.org/monitor.html` | **Pager log** | address, municipality, place/apt, type, units, fire box, agency |

**Pager logs aren't active lists.** There's no "cleared" signal, so York and Lebanon pages are grouped into calls (same box + address) and shown for **2 hours after the last page** (`PAGER_WINDOW_MIN` in `src/sources.js`). Cards from those feeds say "pager log · last page Xm ago". The county chip reads "pager · Xh ago" when a pager feed has been silent for 3+ hours. That usually means the hobbyist decoder feeding the page is down (York's had been quiet for ~8 h when this was built).

Free-text dispatcher notes in York's pages (patient age/sex, condition) are deliberately dropped.

Not used:
- `webcad.lcdes.org`: it opens with a notice that access requires explicit authorization from Lebanon DES.
- Berks and Dauphin: no public feed.

## Run it on your Mac

Requires Node 18+ (`brew install node`).

```bash
cd cad-monitor
npm start          # → http://localhost:8787
npm test           # parser tests
```

`PORT=3000 npm start` for another port. From your phone on the same Wi-Fi: `http://<Mac's LAN IP>:8787`.

**Lebanon TLS note:** `www.lcdes.org` sends its certificate without the GoDaddy G2 intermediate. Browsers quietly fetch the missing piece; Node refuses. `server.js` relaunches Node with `certs/godaddy-g2-intermediate.pem` added via `NODE_EXTRA_CA_CERTS` (merged with any value you already set). Verification stays fully on. Run via `npm start` / `node server.js`, not `node src/node-server.js` directly.

## On your iPhone

It's built as an installable web app: open the deployed URL in **Safari → Share → Add to Home Screen**. It then launches full-screen from its own icon, clears the notch and home indicator, and can show notifications (iOS 16.4+, Home Screen install only, and only while the app is open or recently backgrounded, since there's no push server).

## Put it online (Cloudflare Workers, free)

```bash
npx wrangler login
npx wrangler deploy     # → https://scpa-cad-monitor.<you>.workers.dev
```

The Worker serves `public/` and `/api/incidents` with a 45 s edge cache. Caveat: Workers can't be given an extra CA, so **Lebanon will likely show "unreachable" on Cloudflare** until the county fixes its certificate chain. Everything else works there. If you want Lebanon online too, host `npm start` on any always-on box (a Mac mini, a $5 VPS, Fly.io, Render).

## Features

- Merged, newest-first feed; major calls (working/structure fires, high-risk alarms, cardiac arrest, STEMI, entrapment, rollover, MCI, special/water rescue, RIT) pinned to the top
- County cells with live counts and health in words (agency name when OK; "pager · Xm ago" for pager logs; "page changed" or "unreachable" in red). Hover for the error; tap to hide a county
- Category filter (Fire / EMS / Traffic / Rescue / Police / Other) and text filter across type, place, street, township, box, units and agencies
- **New** flag for 5 min; tab title shows the count of new calls
- **Recently cleared** for the CAD feeds (Lancaster, Chester, Cumberland), with time on incident; kept 6 h in this browser
- Watch keywords (e.g. `STRUCTURE FIRE, MANHEIM TOWNSHIP, MEDIC 06, BOX 89-`) → card flag + alert tone + optional desktop notification; optional alert on every major call
- Map: OpenStreetMap tiles (dimmed in dark mode). York and Cumberland use the exact coordinates in their feeds; the others are geocoded through Nominatim at ≤1 request/s, cached in the browser, and drawn dashed when approximate. Auto-fits to all calls until you pan/zoom
- 30 / 60 / 120 s refresh; dark / light / system theme; works on a phone

## Layout

```
public/index.html        UI (single file, no build step)
src/sources.js           sources, fetch (with one retry on 5xx), parsers, classifier; shared by both servers
src/worker.js            Cloudflare Worker entry
src/node-server.js       Node HTTP server
server.js                launcher (adds Lebanon's missing intermediate cert)
certs/                   GoDaddy Secure CA G2 intermediate (public, expires 2031)
test/parse.test.mjs      parser tests on fixtures that mirror the real markup
```

## When a county changes its page

The chip goes amber ("page changed") or the count drops to zero while the county's own site shows calls. Each county has its own parser in `src/sources.js` (`parseLCWC`, `parseChesco`, `parseCumberland`, `parseYork`, `parseLebanon`); update it and add a fixture to the tests.

## Etiquette

The York, Chester and Lebanon pages disallow crawlers in robots.txt. This tool fetches one public page per county per refresh for personal monitoring with a descriptive User-Agent. Keep the interval at 60 s or longer and don't turn it into a high-traffic public service without asking those agencies. Feeds are delayed and omit most police calls. Not for emergency use.

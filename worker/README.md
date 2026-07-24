# Menu proxy (Vercel)

Server-side proxy the browser-based Framer plugin calls to fetch menu data. Its source lives
in this repo (this folder) so it can be reviewed alongside the plugin.

## Why the plugin needs a backend

The plugin runs in the browser, which **cannot** do either platform's fetch itself:

- **Omega** (`menu.omegasoftware.ca`) requires a Laravel cookie/XSRF **auth dance** — load the
  page to collect `PHPSESSID` / `XSRF-TOKEN` cookies, then POST `getRestaurantMenu` with the
  URL-decoded token. Browsers can't read cross-origin `Set-Cookie` or replay it.
- **redro** (`redro.menu`) has **no menu-content API** — the menu is server-rendered HTML with
  schema.org microdata that must be **scraped cross-origin** (and item photos live on per-item
  detail pages). Browsers are blocked from cross-origin scraping.

The worker does both server-side and returns JSON. It is a dumb, stateless pass-through/parser.

## Data minimization & privacy

The plugin transmits **only a public menu identifier** — the Omega customer id (e.g. `tavolina`)
or the redro menu URL (e.g. `https://amar.redro.menu/en/restaurant/jeddah.html`). **No user data,
credentials, project data, or PII** is ever sent. Responses contain only public menu content.
The worker needs **no secrets** and stores nothing.

## Production endpoint

Use a **production** deployment URL for marketplace builds — not a preview/staging one. Set
`VITE_WORKER_BASE` at build time to point the plugin at it (see the plugin's `data.ts`).

## Routes

| Route | Source | Returns |
|-------|--------|---------|
| `GET /menu/{customerid}` | Omega `POST getRestaurantMenu` | `{ branch, categories, menu, sd_menus }` |
| `GET /data/{customerid}` | Omega `POST getRestaurantData` | branch/brand info |
| `GET /redro?url={menuUrl}` | redro HTML (scraped, cheerio) | `{ brand, categories, sections, items }` |

`customerid` is validated against `^[a-z0-9_-]{1,40}$`; `/redro`'s `url` must be a `redro.menu`
host. Bad input returns `400`; upstream failures return `502` with a clear JSON error.

The `/redro` response is the fully-parsed, plugin-ready shape (item images + calories included):
one landing-page fetch → one fetch per category sub-page → one fetch per item detail page for
photos (concurrency-limited to 8, ~175 pages ≈ 6s). Edge-cached ~5 min like the Omega routes.

## Layout

```
worker/
  api/
    _omega.js            # fetchOmega() — Omega auth dance
    _handler.js          # CORS + validation + caching wrapper (Omega routes)
    _redro.js            # fetchRedroMenu() — redro HTML scrape → shared shape
    health.js            # GET /api/health (aliased to /health) — liveness for uptime monitors
    menu/[customerid].js # GET /api/menu/:id  (aliased to /menu/:id)
    data/[customerid].js # GET /api/data/:id  (aliased to /data/:id)
    redro.js             # GET /api/redro    (aliased to /redro)
  vercel.json            # rewrites + /redro maxDuration
  package.json           # cheerio (redro scraping)
```

## Monitoring

`GET /health` returns `{ ok: true, … }` without touching either platform — point an uptime
monitor (e.g. UptimeRobot, free) at it to know the worker is up. Add a second monitor on
`/menu/tavolina` for full end-to-end coverage; that path is edge-cached (~5 min) so frequent
checks mostly hit the cache and don't load Omega.

## Deploy

```bash
cd worker
vercel            # preview deploy
vercel --prod     # production
```

## Test

```bash
curl https://<deployment>/menu/tavolina | head
curl "https://<deployment>/redro?url=https://amar.redro.menu/en/restaurant/jeddah.html" | head
```

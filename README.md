# Restaurant Menu Import — Framer plugin

Import a restaurant menu straight into Framer CMS — as a linked, nestable hierarchy — one or many locations at once.

Supported menu providers (dispatched on the URL host):

| Provider | Menu link | Notes |
|---|---|---|
| **Omega Software's oMenu** | `menu.omegasoftware.ca/{customerid}` | JSON API, USD default |
| **redro.menu** | `{venue}.redro.menu/{locale}/restaurant/{location}.html` | SAR default; adds item **photos** + **calories** |

Paste one or more menu links (one per line — Omega and redro can be mixed), choose exactly what to
sync, and the plugin creates and populates one set of managed collections for all of them:

**Menu Locations → Menu Categories → Menu Sections → Menu Items**

Each menu becomes a Location, so a single page template on Menu Locations renders every venue.

## Features

- **One-click import** of every menu into four plugin-managed collections with a shared prefix:
  `{{Prefix}}-Menu Locations`, `-Menu Categories`, `-Menu Sections`, `-Menu Items`.
- **4-level hierarchy, linked both ways** — child→parent references *and* parent→children
  multi-references, so you can nest Collection Lists (source an inner list from *Current
  Item's Sections / Items*).
- **Selective import** — toggle which levels to create, pick which categories/sections to
  include, and filter items (only popular / new, skip items with no price).
- **Editable** — change the Omega link or the filters of an already-synced collection and
  re-import.
- **Resync-friendly** — item ids are the Omega ids, so re-syncing updates in place with no
  duplicates; your choices persist for Framer's resync button.
- **Handles real-world data** — dynamic categories per venue, dual-priced items (Price Note),
  duplicate names, dirty POS fields.

## Repository layout

```
/            the Framer plugin (@framer/plugin v4, Vite + React + TS)
  src/       plugin UI + sync logic (src/lib/transform.ts shapes Omega → CMS)
  worker/    Vercel proxy the plugin calls (does Omega's cookie/XSRF auth dance + CORS,
             which a browser can't) — deploy this and point VITE_WORKER_BASE at it
```

## Develop

```bash
npm install
npm run dev        # serves the plugin over https (mkcert)
```

Then in Framer: **Plugins → open the local dev URL**, create a CMS collection, and manage it
with **Restaurant Menu Import**.

```bash
npm run check      # tsc + eslint
npm run build      # production bundle in dist/
```

The worker base URL is overridable at build time:

```bash
VITE_WORKER_BASE=https://your-worker.vercel.app npm run build
```

## Worker

The plugin needs the `worker/` proxy deployed (any serverless host; Vercel by default). See
[worker/README.md](worker/README.md).

# Omega Menu Import — Framer plugin

Import any restaurant menu hosted on **Omega Software's oMenu** platform
(`menu.omegasoftware.ca/{customerid}`) straight into Framer CMS — as a linked,
nestable 3-level hierarchy.

Paste a menu URL (or customer id), choose exactly what to sync, and the plugin creates and
populates three managed collections in one import:

**Menu Categories → Menu Sections → Menu Items**

## Features

- **One-click import** of the full menu into three plugin-managed collections.
- **3-level hierarchy, linked both ways** — child→parent references *and* parent→children
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
with **Omega Menu Import**.

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

## Scheduled sync

For unattended, editor-closed syncing (into user-created collections via Framer's Server
API), see the companion project — it runs on a schedule via GitHub Actions.

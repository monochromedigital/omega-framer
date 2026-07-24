# Restaurant Menu Import — Framer plugin (project context)

## What this is

A Framer plugin that imports a restaurant menu into Framer CMS as a linked, nestable
**3-level hierarchy**: Menu Categories → Menu Sections → Menu Items. Two platforms, dispatched
on the URL host (`parseMenuSource` in `data.ts`):
- **Omega Software's oMenu** — `https://menu.omegasoftware.ca/{customerid}` (JSON POST API,
  USD default). Fetched via the worker's `/menu/{id}`, then `transform()`.
- **redro.menu** — `https://{sub}.redro.menu/{locale}/restaurant/{loc}.html` (no content API;
  server-rendered schema.org HTML, SAR default). Scraped **server-side in the worker**
  (`/redro?url=…`, cheerio) into the same `{ brand, categories, sections, items }` shape, so
  `data.ts` is platform-agnostic. redro ids are strings (UUID/slug) → menu ids are `number |
  string` (`SourceId`). redro adds item **images** (detail-page photos) + **calories**.

Menu Items carry `Image` (image), `Calories` (plain text — NOT number; Framer rejects optional
numbers), and `Currency` (plain text) fields; image/calories are written only when present.

**Goal:** publish it on the Framer Marketplace. Repo is public:
`monochromedigital/omega-framer`. This repo is only the plugin.

## Repo layout (plugin is the repo root)

```
/                     the Framer plugin — @framer/plugin v4, Vite + React + TS
  framer.json         plugin manifest (modes: canvas, configureManagedCollection,
                      syncManagedCollection)
  src/
    main.tsx          entry: branch on framer.mode — CMS modes (resync vs show UI) vs the
                      OpenFromCMS guard for any non-CMS (canvas) launch
    App.tsx           two-step flow: SelectMenu → ConfigureImport
    SelectMenu.tsx    step 1 — paste customer id/URL, load a live preview
    ConfigureImport.tsx  step 2 — pick levels/categories/sections/item filters, Import
    OpenFromCMS.tsx   guard screen shown when opened outside the CMS (canvas mode)
    data.ts           ALL sync logic (brand, fields, items, references, import/resync)
    lib/transform.js  Omega JSON → { brand, categories, sections, items } (+ .d.ts)
  worker/             Vercel proxy the plugin calls (browser can't do Omega's auth dance)
```

## How it works (key design)

- **CMS-only.** The plugin runs from the CMS ("＋ New Collection → manage with Restaurant Menu
  Import"), i.e. `configureManagedCollection` / `syncManagedCollection` modes. Canvas mode is
  declared in the manifest only so a Plugins-menu launch shows an "Open from the CMS" guard
  (`src/OpenFromCMS.tsx`) instead of erroring — canvas blocks the managed-collection APIs the
  plugin needs (`getManagedCollections`, `setActiveCollection`, and collection population).
- **One import → three managed collections.** The active collection (Framer creates + names it)
  becomes **Menu Items**; the plugin auto-creates/reuses **Menu Categories** and **Menu
  Sections** via `framer.createManagedCollection()`. Parents synced before children.
- **Naming: `{{Brand}}-{{Collection}}`.** Brand is the venue name from the menu data
  (`branch.BRANCHNAME || BARANCHNAME || OTHERNAME`, surfaced by `transform`). So the created
  collections are e.g. `Tavolina-Menu Categories` / `Tavolina-Menu Sections`. The **active
  (Items) collection can't be renamed** by the plugin (Framer sets its name; there is no rename
  API) → the config screen shows a hint to rename it to `{{Brand}}-Menu Items` in the CMS.
- **Duplicate-name safety.** `createManagedCollection` rejects a name that already exists
  (project-wide, incl. non-managed collections we can't see), so creation retries with a numeric
  suffix (`… 2`, `… 3`). Only new collections get suffixed — the CMS flow reuses the plugin's
  own collections by plugin data first, so resync never spawns copies.
- **Item ids = Omega ids** → resync updates in place, no duplicates.
- **Linked both ways:** up-references (Item→Section, Item/Section→Category) AND
  parent→children `multiCollectionReference` (Category→Sections, Section→Items). The down
  multi-refs are required for nesting — Framer does NOT expose the child up-reference as a
  "Current Item" filter value, so nested lists must be *sourced* from the parent's multi-ref.
- **Selective import + persistence:** config (levels, excluded category/section ids, item
  flags) is saved to plugin data so the resync button re-applies it. Opening the plugin via
  the CMS (configureManagedCollection mode) shows the UI pre-filled → editable link.
- **Dynamic categories:** built from the venue's own `categories[]`, not hardcoded.

## Omega API (reverse-engineered)

No official docs. The plugin fetches through the **worker** (`GET /menu/{customerid}`), which
does the Laravel auth dance server-side:
1. `GET menu.omegasoftware.ca/{customerid}` → collect Set-Cookie (PHPSESSID, XSRF-TOKEN,
   laravel_session).
2. `POST /getRestaurantMenu` with Cookie header + `x-xsrf-token` (URL-decoded XSRF cookie)
   + `content-type: application/json;charset=UTF-8` + origin/referer.

Menu JSON: `{ branch, categories[], menu[], sd_menus[] }`. `branch` = venue/brand info (the
brand name is `BARANCHNAME` — misspelled in Omega's DB — with `OTHERNAME` as a fallback).
`menu[]` = sections (each has ID, DESCRIPTION [clean EN label], MENU_COMMENT, CATEGORYID:[n],
groups[]); `groups[].items[]` = ITEMNAME, ITEMDESCRIPTION, PRICE (number|null), POPULAR,
NEWITEM, allergies[], sizes[].

**Data quirks handled in `transform`:** dual-priced null-PRICE items embed pricing in the
description's first line → split into Price Note; duplicate names → slugs append the Omega id;
section DESCRIPTION is the trustworthy label (GROUPNAME can be mislabeled); second-language
fields are dirty POS aliases (English only).

## Framer plugin API (@framer/plugin v4)

`framer.getActiveManagedCollection()`, `framer.getManagedCollections()`,
`framer.createManagedCollection(name)`; on a collection: `setFields()`, `addItems()`
(upsert by id), `removeItems()`, `getItemIds()`, `getPluginData()/setPluginData()`.
Field types used: string, number, boolean, enum (cases:[{id,name}]), collectionReference
(collectionId), multiCollectionReference (collectionId; value = string[]).
FieldDataInput value shape: `{ type, value }`. `framer.mode` = "canvas" |
"configureManagedCollection" | "syncManagedCollection" (manifest declares all three, but only
the two CMS modes do real work — canvas shows the guard). Permissions via
`framer.isAllowedTo(...)` / `useIsAllowedTo(...)`. Note: some methods are blocked by **mode**
independent of permissions — `getManagedCollections`, `setActiveCollection` (`setAsActive`),
and collection population are rejected in `canvas` mode; `isAllowedTo` does NOT predict this.
A managed collection's `name` is `readonly` — there is no rename API.

## Worker

Deployed on Vercel (Monochrome team): `https://worker-monochrome-dev.vercel.app`
(`/menu/{id}`, `/data/{id}`). Deploys via `vercel --prod` from `worker/` (the Monochrome
Vercel team is Hobby plan → no Git auto-deploy for private/org repos; this repo is public
now, so Git integration may be reconnectable). `VITE_WORKER_BASE` overrides the base at build.
Note: `/data/{id}` returns `0` (needs the correct getRestaurantData payload) — non-blocking,
branch info is embedded in `/menu`.

## Dev / build

```bash
npm install
npm run dev        # https dev server (mkcert); open the URL in Framer → Plugins
npm run check      # tsc + eslint (must stay clean)
npm run build      # dist/
```

## Current state

**Verified in the Framer editor (CMS flow):** import creates + populates the three collections
(Items = the active collection, plus `{{Brand}}-Menu Categories` / `Sections`); tsc/eslint/build
all clean. A canvas (Plugins-menu) launch correctly shows the OpenFromCMS guard. Still to check:
nested-list sourcing from the down multi-refs, and the resync button end-to-end. Not yet
submitted to the marketplace (needs: icon/screenshots, listing copy, possibly a LICENSE).

Known Framer constraint that shaped the design: a canvas-launched instance can *create* a
managed collection but is blocked from `getManagedCollections`, `setActiveCollection`, and
populating it — so the plugin is CMS-only and guards non-CMS launches.

## Conventions

- Node 22+, ESM, TS strict (tsconfig has `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- Keep `npm run check` clean. Match the existing code style (4-space indent, no semicolons
  per Prettier config).
- Never commit secrets. Worker needs none; the plugin has no secrets.

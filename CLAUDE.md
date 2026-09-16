# Restaurant Menu Import — Framer plugin (project context)

## What this is

A Framer plugin that imports one or more restaurant menus into Framer CMS as a linked, nestable
**4-level hierarchy**: Menu Locations → Menu Categories → Menu Sections → Menu Items. One import
takes several menu links (one per line, platforms can be mixed); every venue lands in the SAME
set of collections, one Location row per menu. Two platforms, dispatched
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
    SelectMenu.tsx    step 1 — paste menu links (one per line), load a live preview
    ConfigureImport.tsx  step 2 — prefix, levels, location names, categories/sections, item filters
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
- **One import → up to four managed collections, shared by every menu in it.** A fresh active
  collection (Framer creates + names it) becomes **Menu Items**; the plugin creates/reuses
  **Menu Locations**, **Menu Categories**, **Menu Sections** via
  `framer.createManagedCollection()`. Reopening the plugin from any of them keeps that
  collection's level. Parents synced before children. The point: ONE page template on Menu
  Locations renders every venue (nested lists sourced from the down multi-refs).
- **Collections of one import share a `groupId`** (plugin data). Lookup is (dataSourceId,
  groupId) — dataSourceId alone is shared by all imports, and matching on it alone once made a
  second import overwrite the first one's collections. Legacy single-menu collections have no
  groupId; their `customerId` acts as the group key and is cleared after the next sync.
- **Location-scoped ids.** Menu ids are only unique per venue (Omega branches share section ids;
  redro locations share category/section slugs), so every row id is `{locationKey}:{menuId}`
  and slugs are prefixed with the location slug. `locationKey` = Omega customer id, or
  `{sub}-{location}` for redro.
- **All-or-nothing fetch.** Every menu is fetched before anything is written; if one fails, the
  sync aborts, so a flaky source never wipes that venue's rows.
- **Naming: `{{Prefix}}-{{Collection}}`.** Prefix defaults to the venue name (one menu) or the most
  common first word of the venue names ("Amar"), editable on the config screen, as are the
  location display names (Omega's venue name can be a legal entity, e.g. "Food And Food Sal").
  The **active collection can't be renamed** by the plugin (no rename API) → the config screen
  shows a rename hint.
- **Duplicate-name safety.** `createManagedCollection` rejects a name that already exists
  (project-wide, incl. non-managed collections we can't see), so creation retries with a numeric
  suffix (`… 2`, `… 3`). Only new collections get suffixed — the CMS flow reuses the plugin's
  own collections by plugin data first, so resync never spawns copies.
- **Item ids = scoped menu ids** → resync updates in place, no duplicates.
- **Linked both ways:** up-references (Item→Section/Category/Location, Section→Category/Location,
  Category→Location) AND parent→children `multiCollectionReference` to the next enabled level
  (Location→Categories, Category→Sections, Section→Items). The down
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

**Multi-location import** (Locations level, scoped ids, groupId) is verified only in a mock-CMS
simulation with the five Amar menus — not yet in the Framer editor.
**Verified in the Framer editor (CMS flow), single-menu version:** import creates + populates the
three collections (Items = the active collection, plus `{{Brand}}-Menu Categories` / `Sections`); tsc/eslint/build
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

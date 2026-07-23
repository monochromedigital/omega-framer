# Omega Menu Import — Framer plugin (project context)

## What this is

A Framer plugin that imports any restaurant menu hosted on **Omega Software's oMenu**
platform (`https://menu.omegasoftware.ca/{customerid}`) into Framer CMS as a linked,
nestable **3-level hierarchy**: Menu Categories → Menu Sections → Menu Items.

**Goal:** publish it on the Framer Marketplace. Repo is public:
`monochromedigital/omega-framer`.

A separate **private** repo `monochromedigital/omega-menu-sync` handles unattended scheduled
sync via the Framer Server API (do not confuse the two — that one is not part of this repo).

## Repo layout (plugin is the repo root)

```
/                     the Framer plugin — @framer/plugin v4, Vite + React + TS
  framer.json         plugin manifest (modes: configureManagedCollection, syncManagedCollection)
  src/
    main.tsx          entry: resync-on-open vs show UI (config vs sync mode)
    App.tsx           two-step flow: SelectMenu → ConfigureImport
    SelectMenu.tsx    step 1 — paste customer id/URL, load a live preview
    ConfigureImport.tsx  step 2 — pick levels/categories/sections/item filters, Import
    data.ts           ALL sync logic (fields, items, references, import/resync)
    lib/transform.js  Omega JSON → { categories, sections, items } (+ .d.ts). Self-contained
                      copy; the automation repo has its own — keep them in sync.
  worker/             Vercel proxy the plugin calls (browser can't do Omega's auth dance)
```

## How it works (key design)

- **One import → three managed collections.** The active collection becomes **Menu Items**;
  the plugin auto-creates/reuses **Menu Categories** and **Menu Sections** via
  `framer.createManagedCollection()`. Parents synced before children.
- **Item ids = Omega ids** → resync updates in place, no duplicates.
- **Linked both ways:** up-references (Item→Section, Item/Section→Category) AND
  parent→children `multiCollectionReference` (Category→Sections, Section→Items). The down
  multi-refs are required for nesting — Framer does NOT expose the child up-reference as a
  "Current Item" filter value, so nested lists must be *sourced* from the parent's multi-ref.
- **Selective import + persistence:** config (levels, excluded category/section ids, item
  flags) is saved to plugin data so the resync button re-applies it. Opening the plugin via
  the plugin menu (configureManagedCollection mode) shows the UI pre-filled → editable link.
- **Dynamic categories:** built from the venue's own `categories[]`, not hardcoded.

## Omega API (reverse-engineered)

No official docs. The plugin fetches through the **worker** (`GET /menu/{customerid}`), which
does the Laravel auth dance server-side:
1. `GET menu.omegasoftware.ca/{customerid}` → collect Set-Cookie (PHPSESSID, XSRF-TOKEN,
   laravel_session).
2. `POST /getRestaurantMenu` with Cookie header + `x-xsrf-token` (URL-decoded XSRF cookie)
   + `content-type: application/json;charset=UTF-8` + origin/referer.

Menu JSON: `{ branch, categories[], menu[], sd_menus[] }`. `menu[]` = sections (each has ID,
DESCRIPTION [clean EN label], MENU_COMMENT, CATEGORYID:[n], groups[]); `groups[].items[]` =
ITEMNAME, ITEMDESCRIPTION, PRICE (number|null), POPULAR, NEWITEM, allergies[], sizes[].

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
FieldDataInput value shape: `{ type, value }`. `framer.mode` = "configureManagedCollection" |
"syncManagedCollection". Permissions via `framer.isAllowedTo(...)` / `useIsAllowedTo(...)`.

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

Works end-to-end up to the Framer API boundary; tsc/eslint/build all clean. **Not yet
verified inside the Framer editor** — createManagedCollection/setFields/addItems and the
nested-list sourcing need a manual test in Framer. Not yet submitted to the marketplace
(needs: icon/screenshots, listing copy, possibly a LICENSE, and the in-editor test pass).

## Conventions

- Node 22+, ESM, TS strict (tsconfig has `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- Keep `npm run check` clean. Match the existing code style (4-space indent, no semicolons
  per Prettier config).
- Never commit secrets. Worker needs none; the plugin has no secrets.
- If you change `src/lib/transform.js`, apply the same change to omega-menu-sync's copy.

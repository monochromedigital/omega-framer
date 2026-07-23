# Omega Menu → Framer CMS — project context

## Goal

Build a system that imports any restaurant menu hosted on Omega Software's oMenu platform
(`https://menu.omegasoftware.ca/{customerid}`) into Framer CMS. Three components:

1. **`worker/`** — Cloudflare Worker proxy (BUILD FIRST). Wraps the Omega API server-side
   (cookie/XSRF bootstrap, CORS headers, optional KV caching) so a browser-based Framer
   plugin can call it.
2. **`plugin/`** — Framer plugin (BUILD SECOND). UI: paste an Omega menu URL or customer id
   → creates/syncs plugin-managed CMS collections. Uses the `framer-plugin` package,
   `syncManagedCollection` mode, external IDs = Omega IDs. Scaffold with
   `npm create framer-plugin`.
3. **`sync/`** — ALREADY BUILT AND WORKING (do not rewrite; reuse its transform logic).
   Node script + GitHub Action using `framer-api` (Server API) for unattended scheduled
   sync into user-created (unmanaged) collections. Lives in this repo; see `sync/sync.js`.

Reference venue for testing: `customerid = "tavolina"`.

## Omega API (reverse-engineered, verified 2026-07)

No official docs. The menu page is an Angular app; data comes from these endpoints:

- `POST https://menu.omegasoftware.ca/getRestaurantMenu`
  body: `{"customerid":"tavolina","has_table":0}` — full menu (categories → menu sections → groups → items)
- `POST https://menu.omegasoftware.ca/getRestaurantData` — branch/brand info (name, address, phones, socials, languages, currency)

**Auth dance (Laravel):** endpoints require session cookies + XSRF header. Bootstrap:
1. `GET https://menu.omegasoftware.ca/{customerid}` → collect `Set-Cookie` (PHPSESSID,
   XSRF-TOKEN, laravel_session)
2. POST with `Cookie:` header + `x-xsrf-token: <URL-decoded value of XSRF-TOKEN cookie>`
   + `content-type: application/json;charset=UTF-8` + `origin`/`referer` set to the site.

A working implementation of this exists in `sync/sync.js` → `fetchOmegaMenu()`. Port it to
the Worker verbatim.

## Menu JSON shape & data quirks (learned from real Tavolina data)

Structure: `{ branch, categories[], menu[], sd_menus[] }`
- `categories`: e.g. `[{CATEGORYID:1, CATEGORYNAME:"Food"}, {CATEGORYID:2, CATEGORYNAME:"Beverages"}]`
- `menu[]` = sections (Antipasti, Pizze, wine regions…). Each has `ID`, `DESCRIPTION`
  (clean EN label — use this), `MENU_COMMENT`, `CATEGORYID:[n]`, `groups[]`.
- `groups[].items[]`: `ID`, `ITEMNAME`, `ITEMDESCRIPTION`, `PRICE` (number|null),
  `POPULAR`, `NEWITEM`, `CALORIES`, `PIC`, `allergies[]`, `sizes[]`.

Quirks that MUST be handled (already handled in `sync/sync.js` transform — reuse it):
- **Second-language fields (`AITEMNAME`, `ADESCRIPTION`, `AGROUPNAME`…) are garbage for
  venues where `branch.MAIN_LANG === branch.SECOND_LANG` — internal POS aliases like
  "ss", "dddd", stale vintages. Only sync them as translations when the two langs differ.**
- `PRICE: null` items embed dual pricing in the description's first line
  (e.g. `"Aust 45 $/Braz 34 $\nTenderloin, wedges"`) → split into `priceNote` + clean description.
- Duplicate item names exist across sections (e.g. "Chateau Marsyas 2018" in both red and
  white wine) → slugs must append the Omega ID: `chateau-marsyas-2018-103`.
- `GROUPNAME` can be mislabeled in the POS ("Bordeaux" on a whisky section); section
  `DESCRIPTION` is the trustworthy label.
- `PIC` fields are relative paths under `https://menu.omegasoftware.ca/` when present
  (all null for Tavolina); `CALORIES`/`allergies`/`sizes` unused for Tavolina but exist
  in the schema for other venues.

## CMS schema (mirror this in the plugin's managed collections)

- **Menu Sections**: Title, Category (enum: Food/Beverages), Comment (string),
  Sort Order (number), Omega ID (number, upsert key)
- **Menu Items**: Title, Description (string), Price (number, nullable),
  Price Note (string), Section (collectionReference → Menu Sections),
  Popular (boolean), New (boolean), Sort Order (number), Omega ID (number, upsert key)
- Optional future fields when venue data has them: Image, Calories, Allergens, Sizes.

## Framer API knowledge (verified against framer-api@0.1.24 type definitions)

Server API (`framer-api`, used by `sync/`): `connect(projectUrl, apiKey)` → `Framer`;
`framer.getCollections()` → `Collection[]` (unmanaged); `collection.getFields()/getItems()/
addItems()/removeItems()`; `addItems` upserts when `id` given, creates when omitted;
`fieldData` keyed by field id with `{type, value}`; enum value = case **id** (resolve from
`field.cases` by name); `framer.publish()` → `{deployment, hostnames}`;
`framer.deploy(deploymentId)` → production. Runs on Node 22+ and Cloudflare Workers.

Plugin API (`framer-plugin`, for `plugin/`): managed collections via
`framer.getActiveManagedCollection()` in `syncManagedCollection` /
`configureManagedCollection` modes; `setFields()` then `addItems()` with plugin-controlled
item ids (use Omega IDs) — Framer provides the resync button on managed collections.
Check current docs at https://www.framer.com/developers (plugins 3.x) before coding —
the API is in active development.

## Worker requirements

- Route: `GET /menu/{customerid}` → JSON `{branch, categories, menu}` (raw pass-through is
  fine; transform can live client-side in the plugin so the Worker stays dumb).
- Also `GET /data/{customerid}` → getRestaurantData pass-through.
- CORS: `Access-Control-Allow-Origin: *` (or lock to Framer plugin origins), handle OPTIONS.
- Cache in KV or Cache API for ~5 min keyed by customerid (avoid hammering Omega).
- Validate customerid: `^[a-z0-9_-]{1,40}$`; return 502 with a clear message if Omega
  responds with HTML/error (bad slug).
- Deploy with wrangler; no secrets needed.

## Build order & acceptance

1. Worker: `curl https://<worker>/menu/tavolina` returns the menu JSON with CORS headers.
2. Plugin scaffold: paste "https://menu.omegasoftware.ca/tavolina" (or just "tavolina"),
   click Import → both managed collections appear populated (~40 sections, ~250 items),
   dual-priced items show Price Note, resync updates in place without duplicates.
3. Keep `sync/` working as-is (it targets manually created unmanaged collections and is
   the unattended cron path).

## Conventions

- Node 22+, ESM everywhere. Plain JS or TS — TS preferred for the plugin (scaffold default).
- Reuse `transform()` / `splitPriceNote()` / `slugify()` from `sync/sync.js` — extract into
  a shared module (e.g. `shared/transform.js`) imported by both plugin and sync script.
- Never commit API keys; Framer keys go in env vars / GitHub secrets.

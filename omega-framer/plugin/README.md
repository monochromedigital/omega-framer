# Omega Menu Import — Framer plugin

Imports any Omega oMenu venue into Framer CMS as two linked, plugin-managed collections:
**Menu Sections** and **Menu Items** (items reference their section). Built on Framer's
`@framer/plugin` v4 managed-collection API (`configureManagedCollection` /
`syncManagedCollection`). Data is fetched through the `worker/` proxy and transformed with
the shared logic in `../shared/transform.js` (same code the `sync/` script uses).

## How it works

- **Item ids = Omega IDs.** Each CMS item's id is its Omega ID, so re-syncing updates in
  place (no duplicates) and items can reference sections by Omega ID directly.
- **Two collections, one plugin.** In Framer you create a managed collection and pick a
  source: **Menu Sections** or **Menu Items**. Sync Sections first; when you sync Items the
  plugin finds the Sections collection and wires up the `Section` reference field.
- **Data source** = a menu URL or customer id (e.g. `tavolina`) entered in the UI, stored in
  plugin data so Framer's resync button re-runs unattended.

## Fields

- **Menu Sections**: Title, Category (enum: Food/Beverages), Comment, Sort Order
- **Menu Items**: Title, Description, Price (empty when the POS price is null), Price Note,
  Popular, New, Sort Order, Section (reference → Menu Sections)

## Config

The worker base URL defaults to the deployed proxy and can be overridden at build time:

```bash
VITE_WORKER_BASE=https://your-worker.vercel.app npm run build
```

## Develop / test in Framer

```bash
npm install
npm run dev        # serves the plugin over https (mkcert)
```

Then in the Framer desktop/web editor: **Plugins → Develop → open the local dev URL**, create
a CMS collection, and choose to manage it with **Omega Menu Import**. Import **Menu Sections**
first, then **Menu Items**.

## Checks

```bash
npm run check      # tsc + eslint
npm run build      # production bundle in dist/
```

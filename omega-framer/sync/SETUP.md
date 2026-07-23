# Cron sync — Framer collection setup

The automatic sync (`sync.js` + GitHub Action) writes into **unmanaged** collections you
create by hand in Framer, via the Server API. This is separate from the plugin (which makes
its own managed collections). Follow this once, then the Action keeps them updated.

> Field **names** are matched case-insensitively. If yours differ, edit `CONFIG` at the top
> of `sync.js`. Every collection needs an **Omega ID** number field — it's the upsert key.

## 1. Create three empty collections first

In Framer: **CMS → New Collection**. Create all three by name before adding fields, so the
reference fields below can point at collections that already exist:

- `Menu Categories`
- `Menu Sections`
- `Menu Items`

## 2. Add fields to each

### Menu Categories
| Field | Type |
|-------|------|
| Title | (built-in) |
| Sort Order | Number |
| Omega ID | Number |
| Sections | **Multi Reference → Menu Sections** *(optional — enables nested lists)* |

### Menu Sections
| Field | Type |
|-------|------|
| Title | (built-in) |
| Category | **Reference → Menu Categories** |
| Comment | Plain Text |
| Sort Order | Number |
| Omega ID | Number |
| Items | **Multi Reference → Menu Items** *(optional — enables nested lists)* |

### Menu Items
| Field | Type |
|-------|------|
| Title | (built-in) |
| Description | Plain Text |
| Price | Number |
| Price Note | Plain Text |
| Section | **Reference → Menu Sections** |
| Category | **Reference → Menu Categories** |
| Popular | Toggle |
| New | Toggle |
| Sort Order | Number |
| Omega ID | Number |

**Notes**
- The two **Multi Reference** fields (Categories → Sections, Sections → Items) are the
  parent→children "down-references". Add them to nest Collection Lists by *sourcing* the
  inner list from **Current Item's Sections / Items**. Leave them out to run without nesting.
- **Category as an Option/enum** also works (older setup) — `sync.js` handles either. But a
  Reference is required for Category-level nesting.
- `Menu Categories` is optional overall — omit it and the sync runs 2-level.

## 3. Get credentials

1. **API key** — in the project: `Cmd+K` → "API Keys" → create (`fk_…`).
2. **Project URL** — from the browser: `https://framer.com/projects/YourProject--xxxxxxxx`.

## 4. Test locally (fastest)

```bash
cd omega-framer/sync
npm install
FRAMER_PROJECT_URL="https://framer.com/projects/..." \
FRAMER_API_KEY="fk_..." \
OMEGA_CUSTOMER_ID=tavolina \
node sync.js
```

First run fills the collections; re-runs update in place (matched on **Omega ID**), so
slugs/URLs stay stable. `DEPLOY_PRODUCTION` defaults off — it only publishes to staging.

## 5. Automate (GitHub Action)

1. Repo → **Settings → Secrets and variables → Actions** → add `FRAMER_PROJECT_URL` and
   `FRAMER_API_KEY`.
2. **Actions → Sync Tavolina menu → Run workflow** (manual), or wait for the 6-hourly cron.

## Options (env vars)

| Variable | Default | Effect |
|----------|---------|--------|
| `OMEGA_CUSTOMER_ID` | `tavolina` | Any Omega-hosted venue |
| `REMOVE_MISSING` | `false` | Delete CMS items no longer in the POS |
| `DEPLOY_PRODUCTION` | `false` | Deploy straight to the live domain after publishing |

# Tavolina menu sync — Omega POS → Framer CMS

Pulls the live menu from `menu.omegasoftware.ca/tavolina` (the same JSON API the menu page uses) and upserts it into two Framer CMS collections via the Framer Server API, then publishes.

## One-time setup

1. **Framer API key** — open the project in Framer → Cmd+K → "open settings" → API Keys → create a key.
2. **Project URL** — copy it from your browser, format: `https://framer.com/projects/YourProject--xxxxxxxx`.
3. **Collections** — the script expects these (already created):
   - `Menu Sections`: Title, Category (Option: Food, Beverages), Comment (Plain text), Sort Order (Number), Omega ID (Number)
   - `Menu Items`: Title, Description (Plain text), Price (Number), Price Note (Plain text), Section (Reference → Menu Sections), Popular (Toggle), New (Toggle), Sort Order (Number), Omega ID (Number)

   Field names are matched case-insensitively. If yours differ, edit `CONFIG` at the top of `sync.js`.

## Run locally (first test)

```bash
npm install
FRAMER_PROJECT_URL="https://framer.com/projects/..." \
FRAMER_API_KEY="fk_..." \
node sync.js
```

The first run creates ~40 sections and ~250 items. Re-runs update in place (matched on the Omega ID field) — slugs and page URLs stay stable.

## Automate with GitHub Actions

1. Push this folder to a private GitHub repo.
2. Repo → Settings → Secrets and variables → Actions → add:
   - `FRAMER_PROJECT_URL`
   - `FRAMER_API_KEY`
3. The workflow in `.github/workflows/sync-menu.yml` runs every 6 hours, plus on demand via the "Run workflow" button.

## Options (env vars)

| Variable | Default | Effect |
| --- | --- | --- |
| `OMEGA_CUSTOMER_ID` | `tavolina` | Any other Omega-hosted venue works too |
| `REMOVE_MISSING` | `false` | Delete CMS items that disappeared from the POS |
| `DEPLOY_PRODUCTION` | `false` | After publishing, deploy straight to the live domain |

## Notes

- Only English fields are synced. This venue's second-language POS fields are internal aliases, not translations.
- Items with dual pricing (e.g. "Aust 45$ / Braz 34$") get an empty Price and the text in Price Note — show Price Note in your Framer component when Price is empty.
- If Omega ever changes their endpoint or adds auth, the fetch step in `sync.js` is the only part to touch.

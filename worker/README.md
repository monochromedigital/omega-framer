# Omega proxy (Vercel)

Server-side proxy that wraps the Omega oMenu API so the browser-based Framer plugin can
call it. Does the Laravel cookie/XSRF auth dance (browsers can't), adds open CORS, and
lets Vercel's edge CDN cache each response for ~5 minutes.

Hosted on Vercel Functions (Node 22). No secrets required — it only proxies public menu data.

## Routes

| Route | Proxies | Returns |
|-------|---------|---------|
| `GET /menu/{customerid}` | `POST getRestaurantMenu` | `{ branch, categories, menu, sd_menus }` |
| `GET /data/{customerid}` | `POST getRestaurantData` | branch/brand info |

`customerid` is validated against `^[a-z0-9_-]{1,40}$`. A bad slug returns `502` with a
clear JSON error (Omega serves its HTML shell for unknown venues).

## Layout

```
worker/
  api/
    _omega.js            # fetchOmega() — auth dance
    _handler.js          # CORS + validation + caching wrapper
    menu/[customerid].js # GET /api/menu/:id  (aliased to /menu/:id)
    data/[customerid].js # GET /api/data/:id  (aliased to /data/:id)
  vercel.json            # rewrites /menu + /data → /api/...
```

## Deploy

```bash
cd worker
vercel            # preview deploy
vercel --prod     # production
```

## Test

```bash
curl https://<deployment>/menu/tavolina | head
```

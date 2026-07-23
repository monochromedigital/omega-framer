/**
 * Shared request handler for the Omega proxy routes.
 * CORS (open), method + customerid validation, ~5 min edge caching.
 */

import { fetchOmega, OmegaError } from "./_omega.js"

const ID_RE = /^[a-z0-9_-]{1,40}$/

export async function handleOmega(req, res, endpoint) {
    // CORS — open, since this only proxies public menu data
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "*")

    if (req.method === "OPTIONS") {
        res.status(204).end()
        return
    }
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" })
        return
    }

    const customerid = String(req.query.customerid || "").toLowerCase()
    if (!ID_RE.test(customerid)) {
        res.status(400).json({ error: "Invalid customerid (expected ^[a-z0-9_-]{1,40}$)" })
        return
    }

    try {
        const data = await fetchOmega(endpoint, customerid)
        // Vercel's edge CDN caches per-URL (customerid is in the path) for ~5 min
        res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600")
        res.status(200).json(data)
    } catch (err) {
        const status = err instanceof OmegaError ? err.status : 502
        res.status(status).json({ error: err.message || "Upstream error" })
    }
}

/**
 * GET /redro?url={menuUrl} → parsed redro menu as { brand, categories, sections, items }.
 *
 * Redro has no menu-content API — the menu is server-rendered HTML with schema.org microdata,
 * and the browser can't reliably scrape it cross-origin. This route scrapes it server-side
 * (cheerio) and returns the same shape the plugin's Omega transform produces, item photos
 * included. Only the public menu URL is transmitted; no user data. CORS is open (public data).
 */

import { fetchRedroMenu } from "./_redro.js"

export default async function handler(req, res) {
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

    const rawUrl = String(req.query.url || "")
    let url
    try {
        url = new URL(rawUrl)
    } catch {
        res.status(400).json({ error: "Invalid or missing url" })
        return
    }
    // Only ever fetch redro.menu — never proxy arbitrary hosts.
    if (!/(^|\.)redro\.menu$/i.test(url.hostname)) {
        res.status(400).json({ error: "url must be a redro.menu menu link" })
        return
    }

    try {
        const data = await fetchRedroMenu(url.href, { withImages: true })
        // Edge-cache per URL for ~5 min (scraping ~175 detail pages is expensive).
        res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600")
        res.status(200).json(data)
    } catch (err) {
        res.status(502).json({ error: err?.message || "Upstream error" })
    }
}

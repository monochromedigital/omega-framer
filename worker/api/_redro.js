/**
 * Redro adapter — redro.menu (Blue Beetle) → the same { brand, categories, sections, items }
 * shape the Omega transform produces, so the plugin's importer can consume either platform.
 *
 * This runs SERVER-SIDE in the worker (not the browser): redro has NO menu-content JSON API,
 * and the browser can't reliably scrape cross-origin. The menu is server-rendered HTML with
 * schema.org microdata:
 *   - one page per category:  /{locale}/restaurant/{location}/{category}.html
 *   - MenuSection  → <h2> title inside [itemtype=".../MenuSection"]
 *   - MenuItem     → name / description / price (SAR) / calories, with a UUID data-item-id
 *   - item photos  → only on each item's detail page (<a class="open-popup" href>), as
 *                    itemprop="image" on host t.redro.menu (media.redro.menu is the venue OG
 *                    fallback → treated as "none")
 *
 * Identity is string-based (unlike Omega's numeric ids): items key on their UUID, sections on
 * a "{categorySlug}-{titleSlug}" string, categories on their sub-page slug. The plugin keys
 * every managed-collection item by string anyway, so these drop straight in.
 */

import * as cheerio from "cheerio"

const UA = { "user-agent": "Mozilla/5.0 (compatible; MenuSync/1.0)" }

// ─── Small copies of the shared transform helpers (worker is a standalone package) ──

/** Slugify a label and append an id so duplicate names stay unique. */
const slugify = (text, id) =>
    (
        String(text)
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "") // strip accents (Château → chateau)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "item"
    ) + `-${id}`

/** Collapse whitespace; non-strings → "". */
const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")

async function getHtml(url) {
    const res = await fetch(url, { headers: UA })
    if (!res.ok) throw new Error(`redro page load failed: ${res.status} ${url}`)
    return res.text()
}

/** Title-case a redro nav label ("BEVERAGES" → "Beverages"). */
const titleCase = (s) => clean(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())

/** The venue's display name, used to prefix the generated collection names. The <title>/og:title
 *  reads like "AMAR Jeddah Menu" — drop a trailing "Menu". Falls back to the capitalized subdomain. */
function extractBrand(landingHtml, baseUrl) {
    const $ = cheerio.load(landingHtml)
    const raw = clean($('meta[property="og:title"]').attr("content") || $("title").first().text() || "")
    const brand = raw.replace(/\s*menu\s*$/i, "").trim()
    if (brand) return brand
    const sub = new URL(baseUrl).hostname.split(".")[0] || ""
    return titleCase(sub)
}

/** Discover the category sub-pages linked from the landing page. Returns them in nav order,
 *  de-duplicated (the nav is rendered twice for mobile/desktop). `home` is skipped. */
function discoverCategories(landingHtml, baseUrl) {
    const $ = cheerio.load(landingHtml)
    const u = new URL(baseUrl)
    const dir = u.pathname.replace(/\.html?$/i, "") // /en/restaurant/jeddah
    const cats = []
    const seen = new Set()
    $(`a[href*="${dir}/"]`).each((_, a) => {
        const href = $(a).attr("href") || ""
        const m = href.match(/\/([a-z0-9-]+)\.html?(?:[?#].*)?$/i)
        if (!m) return
        const slug = m[1].toLowerCase()
        if (slug === "home" || seen.has(slug)) return
        const name = titleCase($(a).text())
        if (!name) return
        seen.add(slug)
        cats.push({ id: slug, name, slug, url: new URL(href, u.origin).href })
    })
    return cats
}

/** Concurrency-limited map — redro item images live on per-item detail pages, so `withImages`
 *  means one extra request per item. Cap the parallelism to be gentle on the origin. */
async function mapPool(items, limit, fn) {
    const out = new Array(items.length)
    let i = 0
    async function worker() {
        while (i < items.length) {
            const idx = i++
            out[idx] = await fn(items[idx], idx)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

/** Pull the item photo off a detail page. Real item photos are served from t.redro.menu
 *  (thumbnails); the venue open-graph fallback lives on media.redro.menu — treat that as "none". */
async function fetchItemImage(detailUrl) {
    try {
        const $ = cheerio.load(await getHtml(detailUrl))
        const src = $('[itemprop="image"]').first().attr("content") || $('meta[property="og:image"]').attr("content") || ""
        return new URL(src).hostname === "t.redro.menu" ? src : ""
    } catch {
        return "" // missing/relative src or a bad detail page → no image, never fatal
    }
}

/** Parse one category page into that category's sections + items. */
function parseCategoryPage(html, category, origin) {
    const $ = cheerio.load(html)
    const sections = []
    const items = []
    let sIdx = 0
    $('[itemtype="https://schema.org/MenuSection"]').each((_, sec) => {
        const $sec = $(sec)
        // Untitled sections exist (e.g. the breakfast block) — fall back to the category name.
        const title = clean($sec.find("h2").first().text()) || category.name
        const comment = clean($sec.children("p").first().text())
        // Stable, venue-unique section id: category slug keeps same-named sections apart.
        const sourceId = slugify(title, category.slug)
        sections.push({
            omegaId: sourceId, // "Source ID" — the upsert key (string; Omega's is numeric)
            title,
            slug: sourceId,
            categoryId: category.id,
            category: category.name,
            comment,
            sortOrder: ++sIdx,
        })
        let iIdx = 0
        $sec.find('[itemtype="https://schema.org/MenuItem"]').each((__, it) => {
            const $it = $(it)
            const name = clean($it.find('[itemprop="name"]').first().text())
            if (!name) return
            const description = clean($it.find('[itemprop="description"]').first().text())
            const priceMeta = $it.find('[itemprop="price"]').first().attr("content")
            const price = priceMeta != null && priceMeta !== "" && !Number.isNaN(Number(priceMeta)) ? Number(priceMeta) : null
            const calRaw = clean($it.find(".calories").first().text())
            const calNum = calRaw ? Number(calRaw.replace(/[^\d.]/g, "")) : NaN
            const calories = Number.isFinite(calNum) ? calNum : null
            const uuid = $it.attr("data-item-id") || slugify(name, `${category.slug}-${sIdx}-${iIdx}`)
            const href = $it.find("a.open-popup").first().attr("href") || $it.find("a").first().attr("href") || ""
            items.push({
                omegaId: uuid, // "Source ID" — the UUID is the stable upsert key
                title: name,
                slug: slugify(name, String(uuid).slice(0, 8)),
                description,
                price,
                priceNote: "", // redro has single prices (no dual-price quirk)
                sectionOmegaId: sourceId,
                categoryId: category.id,
                category: category.name,
                popular: false, // redro exposes no popular/new flags
                newItem: false,
                calories,
                image: "", // filled from the detail page when withImages (see fetchRedroMenu)
                detailUrl: href ? new URL(href, origin).href : "", // transient — stripped before return
                sortOrder: ++iIdx,
            })
        })
    })
    return { sections, items }
}

/**
 * Fetch a full redro menu into { brand, categories, sections, items } (the shared shape).
 * `baseUrl` is the venue's Menu Link, e.g. https://amar.redro.menu/en/restaurant/jeddah.html
 */
export async function fetchRedroMenu(baseUrl, { withImages = false } = {}) {
    const origin = new URL(baseUrl).origin
    const landingHtml = await getHtml(baseUrl)
    const brand = extractBrand(landingHtml, baseUrl)
    const categories = discoverCategories(landingHtml, baseUrl)
    if (!categories.length) throw new Error(`No category pages found at ${baseUrl}`)
    const allSections = []
    const allItems = []
    for (const cat of categories) {
        const { sections, items } = parseCategoryPage(await getHtml(cat.url), cat, origin)
        allSections.push(...sections)
        allItems.push(...items)
    }
    // Item photos live on per-item detail pages — fetch them (concurrency-limited) only when asked.
    if (withImages) {
        const withUrl = allItems.filter((it) => it.detailUrl)
        const imgs = await mapPool(withUrl, 8, (it) => fetchItemImage(it.detailUrl))
        withUrl.forEach((it, i) => (it.image = imgs[i]))
    }
    // Drop transient fields the plugin doesn't need.
    for (const it of allItems) delete it.detailUrl
    const cats = categories.map((c) => ({ id: c.id, name: c.name }))
    return { brand, categories: cats, sections: allSections, items: allItems }
}

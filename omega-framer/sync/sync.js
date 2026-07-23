/**
 * Tavolina menu sync — Omega POS (menu.omegasoftware.ca) → Framer CMS
 *
 * Flow:
 *   1. GET the public menu page to obtain Laravel session cookies + XSRF token
 *   2. POST /getRestaurantMenu to fetch the full menu JSON
 *   3. Transform into Sections + Items (English fields only — the second-language
 *      fields in this venue's POS are dirty internal aliases, not translations)
 *   4. Upsert into Framer CMS via the Server API, keyed on the Omega ID field
 *   5. Publish (staging), optionally deploy to production
 *
 * Env vars:
 *   FRAMER_PROJECT_URL   e.g. https://framer.com/projects/Tavolina--aabbccdd1122
 *   FRAMER_API_KEY       from Framer project settings → API Keys
 *   OMEGA_CUSTOMER_ID    default: "tavolina"
 *   REMOVE_MISSING       "true" to delete CMS items no longer in the POS (default: keep)
 *   DEPLOY_PRODUCTION    "true" to push the publish to production (default: staging only)
 *
 * Requires Node 22+.  Run:  node sync.js
 */

import { connect } from "framer-api"
import { fileURLToPath } from "node:url"
import { transform, splitPriceNote, slugify } from "../shared/transform.js"

// ─── Config: match these to your Framer collection & field names ────────────
// Mirrors the plugin's 3-level hierarchy: Categories → Sections → Items, linked by
// reference fields. The Category field on Sections/Items may be a Collection Reference
// (→ Menu Categories) or, for older setups, an Option/enum — both are handled. The
// Menu Categories collection is optional: if you haven't created it, the sync runs
// 2-level and skips category references.
const CONFIG = {
    categoriesCollection: "Menu Categories",
    sectionsCollection: "Menu Sections",
    itemsCollection: "Menu Items",
    categoryFields: {
        title: "Title", // Framer's built-in title field
        sortOrder: "Sort Order", // Number
        omegaId: "Omega ID", // Number  ← upsert key
        sections: "Sections", // Multi Reference → Menu Sections (down-ref) — optional
    },
    sectionFields: {
        title: "Title", // Framer's built-in title field
        category: "Category", // Reference → Menu Categories (or Option: Food | Beverages)
        comment: "Comment", // Plain text
        sortOrder: "Sort Order", // Number
        omegaId: "Omega ID", // Number  ← upsert key
        items: "Items", // Multi Reference → Menu Items (down-ref) — optional
    },
    itemFields: {
        title: "Title", // Framer's built-in title field
        description: "Description", // Plain text
        price: "Price", // Number (optional)
        priceNote: "Price Note", // Plain text (optional)
        section: "Section", // Reference → Menu Sections
        category: "Category", // Reference → Menu Categories (or Option) — optional
        popular: "Popular", // Toggle
        newItem: "New", // Toggle
        sortOrder: "Sort Order", // Number
        omegaId: "Omega ID", // Number  ← upsert key
    },
    // Fields tolerated as missing on existing collections (keeps older setups working).
    // The down-reference multi-fields (Categories.Sections, Sections.Items) are optional:
    // add them in Framer to enable nested Collection Lists sourced from "Current Item".
    optionalFields: { category: ["sections"], section: ["category", "items"], item: ["category"] },
}

const OMEGA_BASE = "https://menu.omegasoftware.ca"
const CUSTOMER_ID = process.env.OMEGA_CUSTOMER_ID || "tavolina"

// ─── Step 1 + 2: fetch menu JSON from Omega ─────────────────────────────────

async function fetchOmegaMenu() {
    // Bootstrap: load the page to collect Laravel session + XSRF cookies
    const pageRes = await fetch(`${OMEGA_BASE}/${CUSTOMER_ID}`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; MenuSync/1.0)" },
    })
    if (!pageRes.ok) throw new Error(`Omega page load failed: ${pageRes.status}`)

    const setCookies = pageRes.headers.getSetCookie?.() ?? []
    const cookieJar = {}
    for (const c of setCookies) {
        const [pair] = c.split(";")
        const eq = pair.indexOf("=")
        if (eq > 0) cookieJar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
    const cookieHeader = Object.entries(cookieJar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    // Laravel expects the XSRF-TOKEN cookie URL-decoded in the x-xsrf-token header
    const xsrf = cookieJar["XSRF-TOKEN"] ? decodeURIComponent(cookieJar["XSRF-TOKEN"]) : ""

    const res = await fetch(`${OMEGA_BASE}/getRestaurantMenu`, {
        method: "POST",
        headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json;charset=UTF-8",
            origin: OMEGA_BASE,
            referer: `${OMEGA_BASE}/${CUSTOMER_ID}`,
            cookie: cookieHeader,
            ...(xsrf ? { "x-xsrf-token": xsrf } : {}),
            "user-agent": "Mozilla/5.0 (compatible; MenuSync/1.0)",
        },
        body: JSON.stringify({ customerid: CUSTOMER_ID, has_table: 0 }),
    })
    if (!res.ok) throw new Error(`getRestaurantMenu failed: ${res.status} ${await res.text()}`)
    return res.json()
}

// ─── Step 3: transform ──────────────────────────────────────────────────────
// transform() / splitPriceNote() / slugify() live in ../shared/transform.js
// (shared verbatim with the Framer plugin). See imports at the top of this file.

// ─── Step 4: upsert into Framer ─────────────────────────────────────────────

function fieldMap(fields, wanted, collectionName, optional = []) {
    const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]))
    const map = {}
    for (const [key, name] of Object.entries(wanted)) {
        const f = byName.get(name.toLowerCase())
        if (!f) {
            if (optional.includes(key)) continue // tolerated as missing on older collections
            throw new Error(`Field "${name}" not found in "${collectionName}". Available: ${fields.map((x) => x.name).join(", ")}`)
        }
        map[key] = f
    }
    return map
}

/** Resolve a Category field value: reference → the category's Framer item id; enum → its name. */
const categoryEntry = (field, categoryId, categoryName, catAfter) => {
    if (field.type === "collectionReference") {
        return entry(field, catAfter?.get(categoryId)?.id ?? null)
    }
    return entry(field, categoryName) // Option/enum (older setups)
}

const entry = (field, value) => {
    switch (field.type) {
        case "string":
        case "formattedText":
            return { type: field.type, value: value ?? "" }
        case "number":
            return { type: "number", value: value ?? null }
        case "boolean":
            return { type: "boolean", value: Boolean(value) }
        case "enum": {
            const match = field.cases.find((c) => c.name.toLowerCase() === String(value).toLowerCase())
            if (!match) throw new Error(`Enum case "${value}" not found on field "${field.name}"`)
            return { type: "enum", value: match.id }
        }
        case "collectionReference":
            return { type: "collectionReference", value: value ?? null }
        case "multiCollectionReference":
            return { type: "multiCollectionReference", value: Array.isArray(value) ? value : [] }
        default:
            throw new Error(`Unhandled field type "${field.type}" on "${field.name}"`)
    }
}

/** Index existing CMS items by their Omega ID field value → Framer item */
function indexByOmegaId(existingItems, omegaField) {
    const map = new Map()
    for (const it of existingItems) {
        const v = it.fieldData[omegaField.id]?.value
        if (v != null) map.set(Number(v), it)
    }
    return map
}

async function addInChunks(collection, rows, size = 50) {
    for (let i = 0; i < rows.length; i += size) {
        await collection.addItems(rows.slice(i, i + size))
        console.log(`   … ${Math.min(i + size, rows.length)}/${rows.length}`)
    }
}

async function main() {
    console.log(`Fetching Omega menu for "${CUSTOMER_ID}"…`)
    const raw = await fetchOmegaMenu()
    const { categories, sections, items } = transform(raw)
    console.log(`Transformed: ${categories.length} categories, ${sections.length} sections, ${items.length} items`)

    const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)
    try {
        const collections = await framer.getCollections()
        const find = (name) => {
            const c = collections.find((x) => x.name.toLowerCase() === name.toLowerCase())
            if (!c) throw new Error(`Collection "${name}" not found. Available: ${collections.map((x) => x.name).join(", ")}`)
            return c
        }
        // Menu Categories is optional — 2-level setups just won't have it.
        const categoriesCol = collections.find((x) => x.name.toLowerCase() === CONFIG.categoriesCollection.toLowerCase())
        const sectionsCol = find(CONFIG.sectionsCollection)
        const itemsCol = find(CONFIG.itemsCollection)

        // Categories first (sections + items reference them)
        let catAfter = new Map()
        let cFields = null
        if (categoriesCol) {
            cFields = fieldMap(await categoriesCol.getFields(), CONFIG.categoryFields, categoriesCol.name, CONFIG.optionalFields.category)
            const cExisting = indexByOmegaId(await categoriesCol.getItems(), cFields.omegaId)
            console.log(`Upserting categories into "${categoriesCol.name}"…`)
            await addInChunks(
                categoriesCol,
                categories.map((c, i) => {
                    const existing = cExisting.get(c.id)
                    return {
                        ...(existing ? { id: existing.id } : {}),
                        slug: existing ? existing.slug : slugify(c.name, c.id),
                        draft: false,
                        fieldData: {
                            [cFields.title.id]: entry(cFields.title, c.name),
                            [cFields.sortOrder.id]: entry(cFields.sortOrder, i + 1),
                            [cFields.omegaId.id]: entry(cFields.omegaId, c.id),
                        },
                    }
                })
            )
            catAfter = indexByOmegaId(await categoriesCol.getItems(), cFields.omegaId)
        } else {
            console.log(`(No "${CONFIG.categoriesCollection}" collection — syncing 2-level, skipping category references.)`)
        }

        // Sections next (items reference them)
        const sFields = fieldMap(await sectionsCol.getFields(), CONFIG.sectionFields, sectionsCol.name, CONFIG.optionalFields.section)
        const sExisting = indexByOmegaId(await sectionsCol.getItems(), sFields.omegaId)

        console.log(`Upserting sections into "${sectionsCol.name}"…`)
        await addInChunks(
            sectionsCol,
            sections.map((s) => {
                const existing = sExisting.get(s.omegaId)
                return {
                    ...(existing ? { id: existing.id } : {}),
                    slug: existing ? existing.slug : s.slug, // keep stable URLs on updates
                    draft: false,
                    fieldData: {
                        [sFields.title.id]: entry(sFields.title, s.title),
                        ...(sFields.category ? { [sFields.category.id]: categoryEntry(sFields.category, s.categoryId, s.category, catAfter) } : {}),
                        [sFields.comment.id]: entry(sFields.comment, s.comment),
                        [sFields.sortOrder.id]: entry(sFields.sortOrder, s.sortOrder),
                        [sFields.omegaId.id]: entry(sFields.omegaId, s.omegaId),
                    },
                }
            })
        )

        // Re-read sections to resolve reference IDs (including freshly created ones)
        const sAfter = indexByOmegaId(await sectionsCol.getItems(), sFields.omegaId)

        // Items
        const iFields = fieldMap(await itemsCol.getFields(), CONFIG.itemFields, itemsCol.name, CONFIG.optionalFields.item)
        const iExisting = indexByOmegaId(await itemsCol.getItems(), iFields.omegaId)

        console.log(`Upserting items into "${itemsCol.name}"…`)
        await addInChunks(
            itemsCol,
            items.map((it) => {
                const existing = iExisting.get(it.omegaId)
                const sectionRef = sAfter.get(it.sectionOmegaId)?.id ?? null
                return {
                    ...(existing ? { id: existing.id } : {}),
                    slug: existing ? existing.slug : it.slug,
                    draft: false,
                    fieldData: {
                        [iFields.title.id]: entry(iFields.title, it.title),
                        [iFields.description.id]: entry(iFields.description, it.description),
                        [iFields.price.id]: entry(iFields.price, it.price),
                        [iFields.priceNote.id]: entry(iFields.priceNote, it.priceNote),
                        [iFields.section.id]: entry(iFields.section, sectionRef),
                        ...(iFields.category ? { [iFields.category.id]: categoryEntry(iFields.category, it.categoryId, it.category, catAfter) } : {}),
                        [iFields.popular.id]: entry(iFields.popular, it.popular),
                        [iFields.newItem.id]: entry(iFields.newItem, it.newItem),
                        [iFields.sortOrder.id]: entry(iFields.sortOrder, it.sortOrder),
                        [iFields.omegaId.id]: entry(iFields.omegaId, it.omegaId),
                    },
                }
            })
        )

        // Re-read items to resolve their Framer ids (for the parent → children down-references)
        const iAfter = indexByOmegaId(await itemsCol.getItems(), iFields.omegaId)

        // ── Pass 2: parent → children multi-references (mirrors the plugin) ──
        // Only runs when the optional multi-reference fields exist on the collections.
        if (categoriesCol && cFields?.sections) {
            const sectionIdsByCategory = new Map()
            for (const s of sections) {
                const fid = sAfter.get(s.omegaId)?.id
                if (!fid) continue
                const list = sectionIdsByCategory.get(s.categoryId) ?? []
                list.push(fid)
                sectionIdsByCategory.set(s.categoryId, list)
            }
            console.log(`Linking sections into "${categoriesCol.name}"…`)
            await addInChunks(
                categoriesCol,
                categories.map((c, i) => {
                    const existing = catAfter.get(c.id)
                    return {
                        ...(existing ? { id: existing.id, slug: existing.slug } : { slug: slugify(c.name, c.id) }),
                        draft: false,
                        fieldData: {
                            [cFields.title.id]: entry(cFields.title, c.name),
                            [cFields.sortOrder.id]: entry(cFields.sortOrder, i + 1),
                            [cFields.omegaId.id]: entry(cFields.omegaId, c.id),
                            [cFields.sections.id]: entry(cFields.sections, sectionIdsByCategory.get(c.id) ?? []),
                        },
                    }
                })
            )
        }
        if (sFields.items) {
            const itemIdsBySection = new Map()
            for (const it of items) {
                const fid = iAfter.get(it.omegaId)?.id
                if (!fid) continue
                const list = itemIdsBySection.get(it.sectionOmegaId) ?? []
                list.push(fid)
                itemIdsBySection.set(it.sectionOmegaId, list)
            }
            console.log(`Linking items into "${sectionsCol.name}"…`)
            await addInChunks(
                sectionsCol,
                sections.map((s) => {
                    const existing = sAfter.get(s.omegaId)
                    return {
                        ...(existing ? { id: existing.id, slug: existing.slug } : { slug: s.slug }),
                        draft: false,
                        fieldData: {
                            [sFields.title.id]: entry(sFields.title, s.title),
                            ...(sFields.category ? { [sFields.category.id]: categoryEntry(sFields.category, s.categoryId, s.category, catAfter) } : {}),
                            [sFields.comment.id]: entry(sFields.comment, s.comment),
                            [sFields.sortOrder.id]: entry(sFields.sortOrder, s.sortOrder),
                            [sFields.omegaId.id]: entry(sFields.omegaId, s.omegaId),
                            [sFields.items.id]: entry(sFields.items, itemIdsBySection.get(s.omegaId) ?? []),
                        },
                    }
                })
            )
        }

        // Optional cleanup: remove CMS items that disappeared from the POS
        if (process.env.REMOVE_MISSING === "true") {
            const liveItemIds = new Set(items.map((i) => i.omegaId))
            const liveSectionIds = new Set(sections.map((s) => s.omegaId))
            const staleItems = [...iExisting].filter(([oid]) => !liveItemIds.has(oid)).map(([, it]) => it.id)
            const staleSections = [...sAfter].filter(([oid]) => !liveSectionIds.has(oid)).map(([, it]) => it.id)
            if (staleItems.length) {
                console.log(`Removing ${staleItems.length} stale items…`)
                await itemsCol.removeItems(staleItems)
            }
            if (staleSections.length) {
                console.log(`Removing ${staleSections.length} stale sections…`)
                await sectionsCol.removeItems(staleSections)
            }
        }

        console.log("Publishing…")
        const result = await framer.publish()
        console.log("Published:", result?.hostnames?.map((h) => h.url ?? h).join(", ") || "ok")

        if (process.env.DEPLOY_PRODUCTION === "true" && result?.deployment?.id) {
            console.log("Deploying to production…")
            await framer.deploy(result.deployment.id)
            console.log("Deployed.")
        }
        console.log("Sync complete ✔")
    } finally {
        await framer.disconnect()
    }
}

// Re-export the shared transform helpers so existing importers of this module keep working.
export { transform, splitPriceNote, slugify }

// Run main() when executed directly. Compare decoded filesystem paths — import.meta.url is
// URL-encoded (spaces → %20) while argv[1] is literal, so a raw string compare breaks on
// paths containing spaces (e.g. ".../Amar Website/...").
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        console.error("Sync failed:", err)
        process.exit(1)
    })
}

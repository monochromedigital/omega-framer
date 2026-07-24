/**
 * Shared Omega → CMS transform logic.
 *
 * Pure, framework-agnostic functions used by the Framer plugin (managed
 * collections).
 *
 * Takes the raw `getRestaurantMenu` JSON and produces flat `sections` + `items`
 * arrays keyed on Omega IDs. See CLAUDE.md for the data quirks these functions
 * handle (dual pricing, duplicate names, dirty second-language fields).
 */

/** Slugify a label and append the Omega ID so duplicate names stay unique
 *  (e.g. "Chateau Marsyas 2018" appears in both red and white wine → -103 / -207). */
export const slugify = (text, id) =>
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
export const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")

/** Best-effort item image URL from Omega's PIC (single) / pictures[] (array of urls or
 *  {url|URL|PICTURE|path} objects). Returns "" when none — these venues carry no photos today,
 *  so this is validated only against the empty case; adjust the object keys if a venue populates it. */
export function itemImage(item) {
    const pic = clean(item?.PIC)
    if (pic) return pic
    const first = Array.isArray(item?.pictures) ? item.pictures[0] : null
    if (typeof first === "string") return clean(first)
    if (first && typeof first === "object") return clean(first.url || first.URL || first.PICTURE || first.path || "")
    return ""
}

/** Descriptions like "Aust 45 $/Braz 34 $\nTenderloin, wedges" carry dual pricing
 *  on the first line when PRICE is null. Split it out into a price note. */
export function splitPriceNote(item) {
    const raw = item.ITEMDESCRIPTION || ""
    if (item.PRICE == null && raw.includes("\n")) {
        const [first, ...rest] = raw.split("\n")
        if (/\d/.test(first) && /\$/.test(first)) {
            return { description: clean(rest.join(" ")), priceNote: clean(first) }
        }
    }
    return { description: clean(raw), priceNote: "" }
}

/** Raw getRestaurantMenu JSON → { brand, categories[], sections[], items[] } keyed on Omega IDs. */
export function transform(data) {
    // Venue/brand name, used to prefix the generated collection names. BARANCHNAME is the
    // (misspelled) branch-name field Omega returns; fall back to OTHERNAME then a clean blank.
    const branch = data.branch || {}
    const brand = clean(branch.BRANCHNAME || branch.BARANCHNAME || branch.OTHERNAME || "")

    // Categories are dynamic per venue (Food/Beverages for Tavolina; others may add
    // Tobacco, Breakfast, …). Expose the full list so consumers can build enums from it.
    const categories = (data.categories || []).map((c) => ({ id: c.CATEGORYID, name: clean(c.CATEGORYNAME) }))
    const categoryName = new Map(categories.map((c) => [c.id, c.name]))
    const sections = []
    const items = []

    data.menu.forEach((section, sIdx) => {
        const catId = section.CATEGORYID?.[0] ?? section.groups?.[0]?.CATEGORYID ?? 1
        sections.push({
            omegaId: section.ID,
            title: clean(section.DESCRIPTION), // DESCRIPTION is the clean EN label
            slug: slugify(section.DESCRIPTION, section.ID),
            categoryId: catId,
            category: categoryName.get(catId) || "Food",
            comment: clean(section.MENU_COMMENT || ""),
            sortOrder: sIdx + 1,
        })
        for (const group of section.groups || []) {
            ;(group.items || []).forEach((item, iIdx) => {
                const { description, priceNote } = splitPriceNote(item)
                items.push({
                    omegaId: item.ID,
                    title: clean(item.ITEMNAME),
                    slug: slugify(item.ITEMNAME, item.ID),
                    description,
                    price: typeof item.PRICE === "number" ? item.PRICE : null,
                    priceNote,
                    sectionOmegaId: section.ID,
                    categoryId: catId, // denormalized from the section for direct filtering
                    category: categoryName.get(catId) || "Food",
                    popular: item.POPULAR !== 0,
                    newItem: item.NEWITEM !== 0,
                    image: itemImage(item),
                    sortOrder: iIdx + 1,
                })
            })
        }
    })
    return { brand, categories, sections, items }
}

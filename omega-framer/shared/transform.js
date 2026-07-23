/**
 * Shared Omega → CMS transform logic.
 *
 * Pure, framework-agnostic functions used by BOTH:
 *   - sync/sync.js       (Server API, unattended cron)
 *   - plugin/            (Framer plugin, managed collections)
 *
 * Takes the raw `getRestaurantMenu` JSON and produces flat `sections` + `items`
 * arrays keyed on Omega IDs. See omega-framer/CLAUDE.md for the data quirks these
 * functions handle (dual pricing, duplicate names, dirty second-language fields).
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

/** Raw getRestaurantMenu JSON → { sections[], items[] } flat arrays keyed on Omega IDs. */
export function transform(data) {
    const categoryName = new Map(data.categories.map((c) => [c.CATEGORYID, clean(c.CATEGORYNAME)]))
    const sections = []
    const items = []

    data.menu.forEach((section, sIdx) => {
        const catId = section.CATEGORYID?.[0] ?? section.groups?.[0]?.CATEGORYID ?? 1
        sections.push({
            omegaId: section.ID,
            title: clean(section.DESCRIPTION), // DESCRIPTION is the clean EN label
            slug: slugify(section.DESCRIPTION, section.ID),
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
                    popular: item.POPULAR !== 0,
                    newItem: item.NEWITEM !== 0,
                    sortOrder: iIdx + 1,
                })
            })
        }
    })
    return { sections, items }
}

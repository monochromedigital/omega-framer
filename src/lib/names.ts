/**
 * Display-name cleanup for POS-sourced menu names (optional, "Clean up names" in the config).
 *
 * Omega names come straight from the restaurant's POS: ALL CAPS ("KSARA SUNSET BTL"), with the
 * branch code of the group they were created in ("CHICKEN BAO-SS"), POS abbreviations (BTL, GLS,
 * 5PCS) and wine-colour prefixes ("W.CHABLIS", "R-PINOT GRIGIO" → "Chablis (White)"). Every name ends up in Title Case
 * ("On The Grill" → "On the Grill"); in names that aren't shouted, words with deliberate inner
 * capitals ("McDonald's", "iPhone") are left as typed.
 */

/** Tokens kept upper-case when title-casing (brand/grade abbreviations). */
const KEEP_UPPER = new Set(["JW", "XO", "VS", "VSOP", "XL", "BBQ", "J&B"])

/** Joiner words kept lower-case except at the start (French/Italian/Lebanese transliterations). */
const LOWER_WORDS = new Set([
    "a",
    "and",
    "or",
    "of",
    "with",
    "in",
    "the",
    "de",
    "du",
    "des",
    "la",
    "le",
    "les",
    "au",
    "aux",
    "et",
    "di",
    "delle",
    "bel",
    "bil",
    "el",
    "w",
])

/** True when at least half the letters are upper-case (tolerates POS typos: "SAMBOUSiK", "NAMMOURA orange"). */
function isMostlyUpper(text: string): boolean {
    const letters = text.replace(/[^A-Za-z]/g, "")
    if (letters.length < 2) return false
    const upper = letters.replace(/[^A-Z]/g, "").length
    return upper / letters.length >= 0.5
}

/** A word typed with capitals past its first letter ("McDonald's", "iPhone"). */
const hasInnerCapitals = (word: string) => /[a-z].*[A-Z]|^[^a-z]*[a-z]+[A-Z]/.test(word)

function titleCaseWord(word: string, index: number, preserveMixed: boolean): string {
    const bare = word.replace(/^[("']+|[)"'.,]+$/g, "")
    if (KEEP_UPPER.has(bare.toUpperCase())) return word.toUpperCase()
    if (preserveMixed && hasInnerCapitals(word)) return word
    const lower = word.toLowerCase()
    if (index > 0 && LOWER_WORDS.has(bare.toLowerCase())) return lower
    // Capitalize the first letter (after any opening bracket/quote); "dewar's" → "Dewar's".
    return lower.replace(/[a-z]/, letter => letter.toUpperCase())
}

/** Title Case; `preserveMixed` keeps words with deliberate inner capitals (used for non-shouted names). */
export function titleCase(text: string, preserveMixed = false): string {
    return text
        .split(/([\s/-]+)/) // "Yogurt/ayran" → "Yogurt/Ayran"
        .map((part, index) => (/^[\s/-]*$/.test(part) ? part : titleCaseWord(part, index, preserveMixed)))
        .join("")
}

/**
 * Clean one menu name. `branchCodes` are the venue platform's branch codes (Omega group prefixes
 * like "HA"/"SS"/"DT"); only those are stripped, so real names ending in "-XX" are left alone.
 */
export function cleanMenuName(name: string, branchCodes: readonly string[] = []): string {
    let text = name.replace(/\s+/g, " ").trim()
    if (!text) return text

    // Trailing branch code: "CHICKEN BAO-SS", "BIZRI (SEASONAL)-DT".
    for (const code of branchCodes) {
        text = text.replace(new RegExp(`\\s*-\\s*${code}$`, "i"), "")
    }
    // Wine colour prefixes "W.CHABLIS" / "R.MICHEL LYNCH" / "R-PINOT GRIGIO" become a "(White)"/"(Red)"
    // suffix, so a white and a red of the same wine don't end up with identical names.
    let colour = ""
    text = text.replace(/^([WR])(?:\.\s*|-)(?=[A-Za-z])/i, (_, letter: string) => {
        colour = letter.toUpperCase() === "W" ? " (White)" : " (Red)"
        return ""
    })

    // Title Case first, so the readable suffixes below keep their own casing. Shouted POS names are
    // fully re-cased; hand-typed names keep words with deliberate inner capitals.
    text = titleCase(text, !isMostlyUpper(text))

    // POS abbreviations → readable suffixes.
    return (text + colour)
        .replace(/\s*\b(\d+)\s*PCS\b\.?/i, " ($1 pcs)")
        .replace(/\s*\bBTL\b\.?/i, " (Bottle)")
        .replace(/\s*\bGLS\b\.?/i, " (Glass)")
        .replace(/\s+/g, " ")
        .trim()
}

/** URL slug from text: accents stripped, lower-case, hyphen-separated. */
export function slugText(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80)
        .replace(/-+$/, "")
}

/**
 * Make slugs unique within one collection: rows sharing a base slug get "-2", "-3"… Suffixes are
 * assigned in id order (not menu order) so re-ordering the menu doesn't swap two items' URLs.
 */
export function uniquifySlugs<T extends { id: string; slug: string }>(rows: T[]): void {
    const groups = new Map<string, T[]>()
    for (const row of rows) {
        const group = groups.get(row.slug) ?? []
        group.push(row)
        groups.set(row.slug, group)
    }
    const taken = new Set(groups.keys())
    for (const [base, group] of groups) {
        if (group.length < 2) continue
        group.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        let next = 2
        for (const row of group.slice(1)) {
            while (taken.has(`${base}-${next}`)) next++
            row.slug = `${base}-${next}`
            taken.add(row.slug)
        }
    }
}

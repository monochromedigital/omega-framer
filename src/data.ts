import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Menu → CMS transform (Omega JSON; redro is scraped server-side by the worker).
import { transform, type MenuCategory, type MenuItem, type MenuSection, type TransformResult } from "./lib/transform.js"

/**
 * Deployed menu proxy (worker/). The worker is REQUIRED because the browser can't do what it
 * does server-side: Omega needs a Laravel cookie/XSRF auth dance the browser is blocked from,
 * and redro has no content API so its HTML must be scraped cross-origin (also browser-blocked).
 * Only a public menu identifier is ever sent to it — the Omega customer id or the redro menu URL;
 * no user data. Overridable at build time via VITE_WORKER_BASE (point this at your production
 * deployment for a marketplace build).
 */
const WORKER_BASE = import.meta.env.VITE_WORKER_BASE ?? "https://worker-monochrome-dev.vercel.app"

const CUSTOMER_ID_RE = /^[a-z0-9_-]{1,40}$/

/** Which menu platform a source points at. */
export type Platform = "omega" | "redro"

export interface MenuSource {
    platform: Platform
    /** Canonical, round-trippable source string: an Omega customer id, or the full redro menu URL. */
    value: string
    /** Default currency for the platform (each menu is a single venue → one currency). */
    currency: string
}

export interface ProviderInfo {
    platform: Platform
    /** Display name, shown on the first screen. */
    name: string
    /** Host shape shown as a hint — mirrors what parseMenuSource dispatches on. */
    host: string
}

/** The menu providers this plugin supports, listed on the first screen so users can tell at a
 *  glance whether their platform works. Keep in sync with parseMenuSource's host dispatch —
 *  adding a provider means a new entry here AND a new branch there. */
export const PROVIDERS: readonly ProviderInfo[] = [
    { platform: "omega", name: "Omega oMenu", host: "menu.omegasoftware.ca" },
    { platform: "redro", name: "redro.menu", host: "*.redro.menu" },
]

// A 4-level hierarchy: Locations → Categories → Sections → Items, one set of collections for
// every menu in the import (each row carries its location). Linked BOTH ways:
//   • up-references   (child → parent)        : Item/Section/Category.location, Item/Section.category, Item.section
//   • down-references (parent → children, multi): Location → next level, Category → next level, Section.items
// The down multi-references let a nested Collection List be sourced directly from
// "Current Item's Categories/Sections/Items" — the reliable way to nest when Framer won't offer
// the up-reference as a "Current Item" filter value. That is also what makes ONE Locations page
// template render every venue's menu.
export type Level = "locations" | "categories" | "sections" | "items"
const LEVELS: readonly Level[] = ["locations", "categories", "sections", "items"]
const LEVEL_SOURCE: Record<Level, string> = {
    locations: "menu-locations",
    categories: "menu-categories",
    sections: "menu-sections",
    items: "menu-items",
}
export const LEVEL_COLLECTION_NAME: Record<Level, string> = {
    locations: "Menu Locations",
    categories: "Menu Categories",
    sections: "Menu Sections",
    items: "Menu Items",
}

export const PLUGIN_KEYS = {
    DATA_SOURCE_ID: "dataSourceId",
    /** Legacy (single-menu) source. Read for backward compatibility; cleared on the next sync. */
    CUSTOMER_ID: "customerId",
    /** JSON array of canonical menu sources (Omega customer ids / redro URLs). */
    MENU_SOURCES: "menuSources",
    /** Shared by the collections of one import, so separate imports never reuse each other's. */
    GROUP_ID: "groupId",
    /** JSON BranchesSource when the menu links are read from a user's branches collection. */
    BRANCHES: "branchesSource",
    IMPORT_CONFIG: "importConfig",
} as const

// ─── Import configuration (what to sync) ─────────────────────────────────────
export interface ItemFlags {
    onlyPopular: boolean
    onlyNew: boolean
    requirePrice: boolean
}

export interface ImportConfig {
    /** Which collections/levels to create. Items is always synced. */
    levels: { locations: boolean; categories: boolean; sections: boolean }
    /** Collection name prefix ("Amar" → "Amar-Menu Items"); null = derived from the venue names. */
    collectionPrefix: string | null
    /** Display-name overrides per location key (the menu data's venue name can be a legal name). */
    locationNames: Record<string, string>
    /** Location-scoped category ids to exclude (cascades to their sections + items). */
    excludedCategoryIds: string[]
    /** Location-scoped section ids to exclude (cascades to their items). */
    excludedSectionIds: string[]
    itemFlags: ItemFlags
}

export const DEFAULT_CONFIG: ImportConfig = {
    levels: { locations: true, categories: true, sections: true },
    collectionPrefix: null,
    locationNames: {},
    excludedCategoryIds: [],
    excludedSectionIds: [],
    itemFlags: { onlyPopular: false, onlyNew: false, requirePrice: false },
}

/**
 * Parse a stored config. `legacyLocationKey` is set for collections synced before multi-location
 * support: their excluded ids are raw menu ids, so they get scoped to that single location.
 */
export function parseImportConfig(raw: string | null, legacyLocationKey: string | null = null): ImportConfig {
    if (!raw) return DEFAULT_CONFIG
    try {
        const parsed = JSON.parse(raw) as Partial<ImportConfig> & {
            excludedCategoryIds?: unknown[]
            excludedSectionIds?: unknown[]
        }
        const scope = (ids: unknown[] | undefined) =>
            (ids ?? []).map(id => (legacyLocationKey ? scopedId(legacyLocationKey, String(id)) : String(id)))
        return {
            levels: { ...DEFAULT_CONFIG.levels, ...parsed.levels },
            collectionPrefix: typeof parsed.collectionPrefix === "string" ? parsed.collectionPrefix : null,
            locationNames: parsed.locationNames ?? {},
            excludedCategoryIds: scope(parsed.excludedCategoryIds),
            excludedSectionIds: scope(parsed.excludedSectionIds),
            itemFlags: { ...DEFAULT_CONFIG.itemFlags, ...parsed.itemFlags },
        }
    } catch {
        return DEFAULT_CONFIG
    }
}

/**
 * Accept a raw Omega customer id ("tavolina"), an Omega menu URL, or a redro menu URL and return
 * the platform-tagged source. Dispatches on the URL host:
 *   • menu.omegasoftware.ca/{id}                       → Omega  (value = customer id, USD)
 *   • {sub}.redro.menu/{locale}/restaurant/{loc}.html  → redro  (value = full URL, SAR)
 * A bare slug (no dot/slash) is treated as an Omega customer id, backward compatible.
 */
export function parseMenuSource(input: string): MenuSource {
    const trimmed = input.trim()
    if (!trimmed) throw new Error("Enter a menu URL or Omega customer id.")

    if (!trimmed.includes("/") && !trimmed.includes(".")) {
        const id = trimmed.toLowerCase()
        if (!CUSTOMER_ID_RE.test(id)) {
            throw new Error(`Invalid customer id “${input}”. Expected a slug like “tavolina” or a menu URL.`)
        }
        return { platform: "omega", value: id, currency: "USD" }
    }

    let url: URL
    try {
        url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    } catch {
        throw new Error(`Invalid menu URL “${input}”.`)
    }
    if (/omegasoftware/i.test(url.hostname)) {
        const seg = url.pathname.split("/").filter(Boolean).pop() ?? ""
        const id = seg.toLowerCase()
        if (!CUSTOMER_ID_RE.test(id)) {
            throw new Error(`Couldn’t find an Omega customer id in “${input}”.`)
        }
        return { platform: "omega", value: id, currency: "USD" }
    }
    if (/(^|\.)redro\.menu$/i.test(url.hostname)) {
        return { platform: "redro", value: url.href, currency: "SAR" }
    }
    throw new Error(`Unrecognized menu URL “${input}”. Expected an Omega or redro menu link.`)
}

/** Split the setup screen's input (one link per line; commas/spaces also accepted) into sources. */
export function splitMenuInput(input: string): string[] {
    return input
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean)
}

/**
 * Stable per-venue key, used to scope row ids and to dedupe links. Menu ids are only unique within
 * a venue (Omega branches share section ids; redro locations share category/section slugs), so
 * every row id is prefixed with this. Omega → customer id; redro → "{sub}-{location}".
 */
export function locationKey(source: MenuSource): string {
    if (source.platform === "omega") return source.value
    const url = new URL(source.value)
    const sub = url.hostname.replace(/\.?redro\.menu$/i, "")
    const location = (url.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.html?$/i, "")
    return [sub, location]
        .filter(Boolean)
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
}

/** ":" never appears in a location key, so scoped ids can't collide across venues. */
const scopedId = (key: string, id: string | number) => `${key}:${id}`

function menuUrlFor(source: MenuSource): string {
    return source.platform === "omega" ? `https://menu.omegasoftware.ca/${source.value}` : source.value
}

/** Slug from text only (transform's slugify appends an id; location slugs read better without). */
function slugText(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
}

// ─── Field value builders ───────────────────────────────────────────────────
const str = (value: string): FieldDataInput[string] => ({ type: "string", value })
const num = (value: number): FieldDataInput[string] => ({ type: "number", value })
const bool = (value: boolean): FieldDataInput[string] => ({ type: "boolean", value })
const ref = (value: string): FieldDataInput[string] => ({ type: "collectionReference", value })
const multiRef = (value: string[]): FieldDataInput[string] => ({ type: "multiCollectionReference", value })
const img = (value: string): FieldDataInput[string] => ({ type: "image", value })
const link = (value: string): FieldDataInput[string] => ({ type: "link", value })

// ─── Fetch + preview ─────────────────────────────────────────────────────────
export interface LocationPreview {
    /** Stable venue key (see locationKey). */
    key: string
    /** Canonical source string persisted for resync (Omega customer id or full redro URL). */
    source: string
    menuUrl: string
    platform: Platform
    /** Venue currency (USD Omega / SAR redro), denormalized onto every imported item. */
    currency: string
    /** Venue name from the menu data. */
    brand: string
    /** The branches-collection item this menu came from (collection input only). */
    branch: Branch | null
    categories: MenuCategory[]
    sections: MenuSection[]
    items: MenuItem[]
}

export interface MenuPreview {
    locations: LocationPreview[]
    /** Set when the links were read from a branches collection (persisted for resync). */
    branches: BranchesSource | null
    branchesCollectionName: string | null
    /** Branch items left out: drafts, or no menu link. */
    skippedBranches: number
}

/** Fetch one menu through the worker. Both platforms yield the shared shape:
 *  Omega returns raw JSON we transform() here; redro is scraped + shaped by the worker. */
async function fetchMenu(source: MenuSource, abortSignal?: AbortSignal): Promise<TransformResult> {
    if (source.platform === "redro") {
        const response = await fetch(`${WORKER_BASE}/redro?url=${encodeURIComponent(source.value)}`, {
            signal: abortSignal,
        })
        if (!response.ok) {
            const body = await response.text().catch(() => "")
            throw new Error(`Failed to load menu from “${source.value}” (${response.status}). ${body}`.trim())
        }
        return (await response.json()) as TransformResult
    }
    const response = await fetch(`${WORKER_BASE}/menu/${source.value}`, { signal: abortSignal })
    if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Failed to load menu for “${source.value}” (${response.status}). ${body}`.trim())
    }
    return transform(await response.json())
}

// ─── Branches collection (menu links read from the user's own CMS collection) ─
/** Where to read branches from: a user collection + the fields holding the menu link and name. */
export interface BranchesSource {
    collectionId: string
    urlFieldId: string
    /** Plain-text field with the branch name; null → the item's slug. */
    nameFieldId: string | null
}

export interface Branch {
    /** The branch's CMS item id (the Menu Location's "Branch" reference points at it). */
    itemId: string
    name: string
}

export interface FieldOption {
    id: string
    name: string
}

export interface BranchCollectionOption {
    id: string
    name: string
    /** Fields that can hold a menu link (Link or Plain Text). */
    linkFields: FieldOption[]
    /** Fields that can hold the branch name (Plain Text). */
    nameFields: FieldOption[]
}

/** The user's own (non-plugin) collections, with the fields usable for links and names. */
export async function listBranchCollections(): Promise<BranchCollectionOption[]> {
    const collections = (await framer.getCollections()).filter(collection => collection.managedBy === "user")
    return Promise.all(
        collections.map(async collection => {
            const fields = await collection.getFields()
            const option = (field: { id: string; name: string }) => ({ id: field.id, name: field.name })
            return {
                id: collection.id,
                name: collection.name,
                linkFields: fields.filter(field => field.type === "link" || field.type === "string").map(option),
                nameFields: fields.filter(field => field.type === "string").map(option),
            }
        })
    )
}

/** Pick the field whose name matches (e.g. /menu/ for the link), else the first field. */
export function guessField(fields: FieldOption[], pattern: RegExp): FieldOption | null {
    return fields.find(field => pattern.test(field.name)) ?? fields[0] ?? null
}

async function readBranches(branches: BranchesSource) {
    const collection = await framer.getCollection(branches.collectionId)
    if (!collection) throw new Error("The branches collection was not found — choose it again.")

    const entries: { link: string; branch: Branch }[] = []
    let skipped = 0
    for (const item of await collection.getItems()) {
        const linkEntry = item.fieldData[branches.urlFieldId]
        const link = linkEntry?.type === "link" || linkEntry?.type === "string" ? (linkEntry.value ?? "").trim() : ""
        if (item.draft || !link) {
            skipped++
            continue
        }
        const nameEntry = branches.nameFieldId ? item.fieldData[branches.nameFieldId] : undefined
        const name = (nameEntry?.type === "string" ? nameEntry.value.trim() : "") || item.slug
        entries.push({ link, branch: { itemId: item.id, name } })
    }
    return { collectionName: collection.name, entries, skipped }
}

/** What to load: pasted links, or the menu links in a branches collection. */
export type MenuInput = { kind: "links"; links: string[] } | { kind: "collection"; branches: BranchesSource }

/**
 * Fetch every menu (in parallel). All-or-nothing: if any menu fails, this throws before anything
 * is written, so a flaky source can never wipe that venue's rows during a sync.
 */
export async function loadMenuPreview(input: MenuInput, abortSignal?: AbortSignal): Promise<MenuPreview> {
    let entries: { link: string; branch: Branch | null }[]
    let branchesCollectionName: string | null = null
    let skippedBranches = 0
    if (input.kind === "links") {
        entries = input.links.map(link => ({ link, branch: null }))
        if (entries.length === 0) throw new Error("Paste at least one menu link.")
    } else {
        const read = await readBranches(input.branches)
        entries = read.entries
        branchesCollectionName = read.collectionName
        skippedBranches = read.skipped
        if (entries.length === 0) {
            throw new Error(`No branches in “${read.collectionName}” have a menu link in the chosen field.`)
        }
    }

    const errors: string[] = []
    const unique = new Map<string, { source: MenuSource; branch: Branch | null }>()
    for (const { link, branch } of entries) {
        try {
            const source = parseMenuSource(link)
            const key = locationKey(source)
            if (!unique.has(key)) unique.set(key, { source, branch })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            errors.push(branch ? `${branch.name}: ${message}` : message)
        }
    }
    if (errors.length > 0) throw new Error(errors.join("\n"))

    const results = await Promise.allSettled(
        Array.from(unique, async ([key, { source, branch }]): Promise<LocationPreview> => {
            const { brand, categories, sections, items } = await fetchMenu(source, abortSignal)
            return {
                key,
                source: source.value,
                menuUrl: menuUrlFor(source),
                platform: source.platform,
                currency: source.currency,
                brand,
                branch,
                categories,
                sections,
                items,
            }
        })
    )

    for (const result of results) {
        if (result.status === "rejected") {
            errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
        }
    }
    if (errors.length > 0) throw new Error(errors.join("\n"))

    return {
        locations: results.flatMap(result => (result.status === "fulfilled" ? [result.value] : [])),
        branches: input.kind === "collection" ? input.branches : null,
        branchesCollectionName,
        skippedBranches,
    }
}

// ─── Naming ──────────────────────────────────────────────────────────────────
export function locationName(location: LocationPreview, config: ImportConfig): string {
    // A branches collection is the source of truth for names (edit them in the CMS).
    if (location.branch) return location.branch.name
    return config.locationNames[location.key]?.trim() || location.brand || location.key
}

/** Default prefix: the venue name for one menu; the most common first word for a group ("Amar"). */
export function defaultCollectionPrefix(preview: MenuPreview): string {
    const brands = preview.locations.map(location => location.brand.trim()).filter(Boolean)
    if (brands.length <= 1) return brands[0] ?? ""
    const counts = new Map<string, number>()
    for (const brand of brands) {
        const first = brand.split(/\s+/)[0] ?? ""
        counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    const [word, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]
    return count >= 2 ? word : ""
}

export function collectionPrefix(preview: MenuPreview, config: ImportConfig): string {
    return config.collectionPrefix ?? defaultCollectionPrefix(preview)
}

/** Prefix a collection name: "Amar" + "Menu Items" → "Amar-Menu Items". */
export function brandedCollectionName(prefix: string, base: string): string {
    const trimmed = prefix.trim()
    return trimmed ? `${trimmed}-${base}` : base
}

// ─── Flattened, location-scoped rows ─────────────────────────────────────────
interface LocationRow {
    id: string
    slug: string
    name: string
    platform: Platform
    currency: string
    menuUrl: string
    branchItemId: string | null
    sortOrder: number
}
interface CategoryRow {
    id: string
    slug: string
    name: string
    locationId: string
    sortOrder: number
}
interface SectionRow {
    id: string
    slug: string
    title: string
    comment: string
    locationId: string
    categoryId: string
    sortOrder: number
}
interface ItemRow {
    id: string
    slug: string
    item: MenuItem
    currency: string
    locationId: string
    categoryId: string
    sectionId: string
}
interface MenuRows {
    locations: LocationRow[]
    categories: CategoryRow[]
    sections: SectionRow[]
    items: ItemRow[]
}

/** Every venue's menu as one set of rows with location-scoped ids + slugs (unfiltered). */
function flatten(preview: MenuPreview, config: ImportConfig): MenuRows {
    const rows: MenuRows = { locations: [], categories: [], sections: [], items: [] }
    const usedSlugs = new Set<string>()

    preview.locations.forEach((location, index) => {
        const name = locationName(location, config)
        let slug = slugText(name) || location.key
        if (usedSlugs.has(slug)) slug = `${slug}-${location.key}`
        usedSlugs.add(slug)

        const locationId = location.key
        const scoped = (id: string | number) => scopedId(location.key, id)
        rows.locations.push({
            id: locationId,
            slug,
            name,
            platform: location.platform,
            currency: location.currency,
            menuUrl: location.menuUrl,
            branchItemId: location.branch?.itemId ?? null,
            sortOrder: index + 1,
        })
        location.categories.forEach((category, categoryIndex) => {
            rows.categories.push({
                id: scoped(category.id),
                slug: `${slug}-${slugText(category.name) || "category"}-${category.id}`,
                name: category.name,
                locationId,
                sortOrder: categoryIndex + 1,
            })
        })
        for (const section of location.sections) {
            rows.sections.push({
                id: scoped(section.omegaId),
                slug: `${slug}-${section.slug}`,
                title: section.title,
                comment: section.comment,
                locationId,
                categoryId: scoped(section.categoryId),
                sortOrder: section.sortOrder,
            })
        }
        for (const item of location.items) {
            rows.items.push({
                id: scoped(item.omegaId),
                slug: `${slug}-${item.slug}`,
                item,
                currency: location.currency,
                locationId,
                categoryId: scoped(item.categoryId),
                sectionId: scoped(item.sectionOmegaId),
            })
        }
    })
    return rows
}

/** Apply the import config: level toggles, category/section exclusions, item flag filters. */
function applyConfig(preview: MenuPreview, config: ImportConfig): MenuRows {
    const all = flatten(preview, config)
    const excludedCats = new Set(config.excludedCategoryIds)
    const excludedSecs = new Set(config.excludedSectionIds)

    const sections = all.sections.filter(
        section => !excludedCats.has(section.categoryId) && !excludedSecs.has(section.id)
    )
    let items = all.items.filter(row => !excludedCats.has(row.categoryId) && !excludedSecs.has(row.sectionId))
    if (config.itemFlags.onlyPopular) items = items.filter(row => row.item.popular)
    if (config.itemFlags.onlyNew) items = items.filter(row => row.item.newItem)
    if (config.itemFlags.requirePrice) items = items.filter(row => row.item.price !== null)

    return {
        locations: config.levels.locations ? all.locations : [],
        categories: config.levels.categories ? all.categories.filter(category => !excludedCats.has(category.id)) : [],
        sections: config.levels.sections ? sections : [],
        items,
    }
}

/** Live counts of what the current config would import (for the config screen summary). */
export function previewCounts(preview: MenuPreview, config: ImportConfig) {
    const { locations, categories, sections, items } = applyConfig(preview, config)
    return {
        locations: locations.length,
        categories: categories.length,
        sections: sections.length,
        items: items.length,
    }
}

/** The (location-scoped) ids the config screen toggles, per location. */
export function scopedCategoryId(location: LocationPreview, category: MenuCategory): string {
    return scopedId(location.key, category.id)
}
export function scopedSectionId(location: LocationPreview, section: MenuSection): string {
    return scopedId(location.key, section.omegaId)
}

// ─── Schema (fields) ─────────────────────────────────────────────────────────
type CollectionIds = Record<Exclude<Level, "items">, string | null> & {
    items: string
    /** The user's branches collection, when Menu Locations link back to it (null = no Branch field). */
    branches: string | null
}

/** The level directly below `level` that is being synced (down multi-references point at it). */
function childLevel(level: Level, ids: CollectionIds): Level | null {
    const below = LEVELS.slice(LEVELS.indexOf(level) + 1)
    return below.find(candidate => ids[candidate] !== null) ?? null
}

function downField(level: Level, ids: CollectionIds): ManagedCollectionFieldInput[] {
    const child = childLevel(level, ids)
    const collectionId = child ? ids[child] : null
    if (!child || !collectionId) return []
    const name = LEVEL_COLLECTION_NAME[child].replace("Menu ", "")
    return [{ id: child, name, type: "multiCollectionReference", collectionId }]
}

function upFields(level: Level, ids: CollectionIds): ManagedCollectionFieldInput[] {
    const parents: [Level, string, string][] = [
        ["locations", "location", "Location"],
        ["categories", "category", "Category"],
        ["sections", "section", "Section"],
    ]
    const fields: ManagedCollectionFieldInput[] = []
    for (const [parent, id, name] of parents.slice(0, LEVELS.indexOf(level))) {
        const collectionId = ids[parent]
        if (collectionId) fields.push({ id, name, type: "collectionReference", collectionId })
    }
    return fields
}

function fieldsFor(level: Level, ids: CollectionIds): ManagedCollectionFieldInput[] {
    const own: Record<Level, ManagedCollectionFieldInput[]> = {
        locations: [
            { id: "title", name: "Title", type: "string" },
            { id: "sortOrder", name: "Sort Order", type: "number" },
            { id: "platform", name: "Platform", type: "string" },
            { id: "currency", name: "Currency", type: "string" },
            { id: "menuUrl", name: "Menu URL", type: "link" },
        ],
        categories: [
            { id: "title", name: "Title", type: "string" },
            { id: "sortOrder", name: "Sort Order", type: "number" },
        ],
        sections: [
            { id: "title", name: "Title", type: "string" },
            { id: "comment", name: "Comment", type: "string" },
            { id: "sortOrder", name: "Sort Order", type: "number" },
        ],
        items: [
            { id: "title", name: "Title", type: "string" },
            { id: "description", name: "Description", type: "string" },
            { id: "price", name: "Price", type: "number" },
            { id: "priceNote", name: "Price Note", type: "string" },
            // Currency is per venue (USD Omega / SAR redro) — denormalized onto every item for rendering.
            { id: "currency", name: "Currency", type: "string" },
            // Calories is Plain Text, NOT Number: Framer's CMS rejects optional Number fields
            // ("Optional numbers are not supported in the CMS") and calories are frequently missing.
            { id: "calories", name: "Calories", type: "string" },
            // Item photo (redro item detail pages; Omega venues carry none). Written only when present.
            { id: "image", name: "Image", type: "image" },
            { id: "popular", name: "Popular", type: "boolean" },
            { id: "newItem", name: "New", type: "boolean" },
            { id: "sortOrder", name: "Sort Order", type: "number" },
        ],
    }
    const branch: ManagedCollectionFieldInput[] =
        level === "locations" && ids.branches
            ? [{ id: "branch", name: "Branch", type: "collectionReference", collectionId: ids.branches }]
            : []
    return [...own[level], ...branch, ...upFields(level, ids), ...downField(level, ids)]
}

// ─── Rows → CMS items ────────────────────────────────────────────────────────
/** Parent id → child ids (order preserved) for the down multi-references. */
function groupChildren(rows: MenuRows, parent: Level, child: Level): Map<string, string[]> {
    type ChildRow = { id: string; locationId?: string; categoryId?: string; sectionId?: string }
    const parentIdOf = (row: ChildRow) =>
        parent === "locations" ? row.locationId : parent === "categories" ? row.categoryId : row.sectionId
    const children: ChildRow[] = rows[child]
    const map = new Map<string, string[]>()
    for (const row of children) {
        const parentId = parentIdOf(row)
        if (parentId === undefined) continue
        const list = map.get(parentId) ?? []
        list.push(row.id)
        map.set(parentId, list)
    }
    return map
}

/**
 * CMS items for one level. Up-references are always written; the down multi-reference only when
 * `withChildren` (pass 2 — every child exists by then).
 */
function cmsItems(
    level: Level,
    rows: MenuRows,
    ids: CollectionIds,
    withChildren: boolean
): ManagedCollectionItemInput[] {
    const child = withChildren ? childLevel(level, ids) : null
    const children = child ? groupChildren(rows, level, child) : null
    const has = (parent: Level) => ids[parent] !== null

    const finish = (id: string, slug: string, fieldData: FieldDataInput, up: Partial<Record<Level, string>>) => {
        if (up.locations && has("locations")) fieldData.location = ref(up.locations)
        if (up.categories && has("categories")) fieldData.category = ref(up.categories)
        if (up.sections && has("sections")) fieldData.section = ref(up.sections)
        if (child && children) fieldData[child] = multiRef(children.get(id) ?? [])
        return { id, slug, draft: false, fieldData }
    }

    switch (level) {
        case "locations":
            return rows.locations.map(row =>
                finish(
                    row.id,
                    row.slug,
                    {
                        title: str(row.name),
                        sortOrder: num(row.sortOrder),
                        platform: str(row.platform),
                        currency: str(row.currency),
                        menuUrl: link(row.menuUrl),
                        ...(ids.branches && row.branchItemId ? { branch: ref(row.branchItemId) } : {}),
                    },
                    {}
                )
            )
        case "categories":
            return rows.categories.map(row =>
                finish(
                    row.id,
                    row.slug,
                    { title: str(row.name), sortOrder: num(row.sortOrder) },
                    { locations: row.locationId }
                )
            )
        case "sections":
            return rows.sections.map(row =>
                finish(
                    row.id,
                    row.slug,
                    { title: str(row.title), comment: str(row.comment), sortOrder: num(row.sortOrder) },
                    { locations: row.locationId, categories: row.categoryId }
                )
            )
        case "items":
            return rows.items.map(row => {
                const { item } = row
                const fieldData: FieldDataInput = {
                    title: str(item.title),
                    description: str(item.description),
                    priceNote: str(item.priceNote),
                    currency: str(row.currency),
                    popular: bool(item.popular),
                    newItem: bool(item.newItem),
                    sortOrder: num(item.sortOrder),
                }
                if (typeof item.price === "number") fieldData.price = num(item.price)
                // Calories → Plain Text; redro supplies a number, Omega has none. Omit when absent.
                if (item.calories != null) fieldData.calories = str(String(item.calories))
                // Image → written only when non-empty (never send an empty/null image value).
                if (item.image) fieldData.image = img(item.image)
                return finish(row.id, row.slug, fieldData, {
                    locations: row.locationId,
                    categories: row.categoryId,
                    sections: row.sectionId,
                })
            })
    }
}

// ─── Stored sync state ───────────────────────────────────────────────────────
export interface StoredSync {
    dataSourceId: string | null
    /** Which level the collection holds (a collection with no plugin data becomes Items). */
    level: Level
    groupId: string | null
    sources: string[]
    /** Set when the menu links are read from a branches collection (resync re-reads it). */
    branches: BranchesSource | null
    config: ImportConfig
}

function levelOf(dataSourceId: string | null): Level {
    return LEVELS.find(level => LEVEL_SOURCE[level] === dataSourceId) ?? "items"
}

export async function readStoredSync(collection: ManagedCollection): Promise<StoredSync> {
    const [dataSourceId, legacySource, rawSources, groupId, rawBranches, rawConfig] = await Promise.all([
        collection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID),
        collection.getPluginData(PLUGIN_KEYS.CUSTOMER_ID),
        collection.getPluginData(PLUGIN_KEYS.MENU_SOURCES),
        collection.getPluginData(PLUGIN_KEYS.GROUP_ID),
        collection.getPluginData(PLUGIN_KEYS.BRANCHES),
        collection.getPluginData(PLUGIN_KEYS.IMPORT_CONFIG),
    ])

    let branches: BranchesSource | null = null
    try {
        const parsed = rawBranches ? (JSON.parse(rawBranches) as Partial<BranchesSource>) : null
        if (parsed?.collectionId && parsed.urlFieldId) {
            branches = {
                collectionId: parsed.collectionId,
                urlFieldId: parsed.urlFieldId,
                nameFieldId: parsed.nameFieldId ?? null,
            }
        }
    } catch {
        // ignore — falls back to the stored links
    }

    let sources: string[] = []
    try {
        const parsed: unknown = rawSources ? JSON.parse(rawSources) : null
        if (Array.isArray(parsed)) sources = parsed.filter((value): value is string => typeof value === "string")
    } catch {
        // fall through to the legacy single source
    }

    // Pre multi-location collections: one menu under "customerId", raw (unscoped) excluded ids.
    let legacyLocationKey: string | null = null
    if (!rawSources && legacySource) {
        sources = [legacySource]
        try {
            legacyLocationKey = locationKey(parseMenuSource(legacySource))
        } catch {
            // unparseable legacy source — keep the config's ids as they are
        }
    }

    return {
        dataSourceId,
        level: levelOf(dataSourceId),
        groupId: groupId ?? legacySource,
        sources,
        branches,
        config: parseImportConfig(rawConfig, legacyLocationKey),
    }
}

// ─── Collection helpers ──────────────────────────────────────────────────────
async function replaceItems(collection: ManagedCollection, items: ManagedCollectionItemInput[]) {
    const unsynced = new Set(await collection.getItemIds())
    for (const item of items) unsynced.delete(item.id)
    await collection.removeItems(Array.from(unsynced))
    await collection.addItems(items)
}

/**
 * Find this import's collection for a level. Matching on the data source id alone isn't enough:
 * every import shares the same ids ("menu-categories"…), so a second import would reuse — and
 * overwrite — the first one's collections. Match on (data source, group), then fall back to the
 * name, but only for a collection not already bound to another import.
 */
async function findGroupCollection(level: Level, groupId: string, name: string): Promise<ManagedCollection | null> {
    const collections = await framer.getManagedCollections()
    const bound = new Set<ManagedCollection>()
    for (const collection of collections) {
        try {
            const dataSourceId = await collection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)
            const groupKey =
                (await collection.getPluginData(PLUGIN_KEYS.GROUP_ID)) ??
                (await collection.getPluginData(PLUGIN_KEYS.CUSTOMER_ID))
            if (groupKey) bound.add(collection)
            if (dataSourceId === LEVEL_SOURCE[level] && groupKey === groupId) return collection
        } catch {
            // ignore collections we can't read
        }
    }
    return collections.find(collection => collection.name === name && !bound.has(collection)) ?? null
}

/**
 * Create a managed collection, appending a numeric suffix if the name is already taken.
 * Framer rejects duplicate names across the whole project (managed or not) and we can't see
 * non-managed collections, so we react to the "already exists" error rather than pre-checking.
 */
async function createCollectionWithUniqueName(baseName: string): Promise<ManagedCollection> {
    for (let suffix = 1; suffix <= 50; suffix++) {
        const name = suffix === 1 ? baseName : `${baseName} ${suffix}`
        try {
            return await framer.createManagedCollection(name)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/already exists/i.test(message)) continue // name taken → try the next suffix
            throw error
        }
    }
    throw new Error(`Could not create a uniquely named collection for “${baseName}”.`)
}

type Collections = Record<Level, ManagedCollection | null>

/** Resolve every enabled level's collection: the active one for its own level, else find (or create). */
async function resolveCollections(
    active: ManagedCollection,
    activeLevel: Level,
    groupId: string,
    prefix: string,
    config: ImportConfig,
    create: boolean
): Promise<Collections> {
    const resolved: Collections = { locations: null, categories: null, sections: null, items: null }
    for (const level of LEVELS) {
        const enabled = level === "items" || config.levels[level]
        if (level === activeLevel && !enabled) {
            throw new Error(`This collection holds ${LEVEL_COLLECTION_NAME[level]} — keep that level enabled.`)
        }
        if (!enabled) continue
        if (level === activeLevel) {
            resolved[level] = active
            continue
        }
        const name = brandedCollectionName(prefix, LEVEL_COLLECTION_NAME[level])
        resolved[level] =
            (await findGroupCollection(level, groupId, name)) ??
            (create ? await createCollectionWithUniqueName(name) : null)
    }
    return resolved
}

/**
 * Sync the whole hierarchy across the resolved collections in two passes:
 *   pass 1 — every row with its scalar fields + up-references (parents first), stale rows removed
 *   pass 2 — the parent→children down multi-references (children now all exist)
 * Two passes are required because parents and children reference each other.
 */
async function runSync(
    collections: Collections,
    preview: MenuPreview,
    rows: MenuRows,
    groupId: string,
    config: ImportConfig
) {
    const items = collections.items
    if (!items) throw new Error("“Menu Items” collection not found — re-import from the plugin.")
    const ids: CollectionIds = {
        locations: collections.locations?.id ?? null,
        categories: collections.categories?.id ?? null,
        sections: collections.sections?.id ?? null,
        items: items.id,
        branches: preview.branches?.collectionId ?? null,
    }
    const synced = LEVELS.flatMap(level => {
        const collection = collections[level]
        return collection ? [{ level, collection }] : []
    })

    // Pass 1, level by level (parents first): fields, then rows + up-references, stale rows removed.
    for (const { level, collection } of synced) {
        try {
            await collection.setFields(fieldsFor(level, ids))
            await replaceItems(collection, cmsItems(level, rows, ids, false))
        } catch (error) {
            // A reference into the user's own branches collection is the one link we can't verify up
            // front. If Framer rejects it, import without the Branch field rather than failing.
            if (level !== "locations" || !ids.branches) throw error
            console.warn("Branch reference rejected; importing Menu Locations without it.", error)
            framer.notify(
                "Couldn’t link Menu Locations to your branches collection — imported without the Branch field.",
                {
                    variant: "warning",
                }
            )
            ids.branches = null
            await collection.setFields(fieldsFor(level, ids))
            await replaceItems(collection, cmsItems(level, rows, ids, false))
        }
    }
    // Pass 2 — parent→children down multi-references (every child now exists).
    for (const { level, collection } of synced) {
        if (childLevel(level, ids)) await collection.addItems(cmsItems(level, rows, ids, true))
    }

    const sources = preview.locations.map(location => location.source)
    for (const { level, collection } of synced) {
        await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, LEVEL_SOURCE[level])
        await collection.setPluginData(PLUGIN_KEYS.GROUP_ID, groupId)
        await collection.setPluginData(PLUGIN_KEYS.MENU_SOURCES, JSON.stringify(sources))
        await collection.setPluginData(PLUGIN_KEYS.BRANCHES, preview.branches ? JSON.stringify(preview.branches) : null)
        await collection.setPluginData(PLUGIN_KEYS.IMPORT_CONFIG, JSON.stringify(config))
        await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, null)
    }
}

// ─── Permissions ─────────────────────────────────────────────────────────────
export const syncMethods = [
    "ManagedCollection.setFields",
    "ManagedCollection.addItems",
    "ManagedCollection.removeItems",
    "ManagedCollection.setPluginData",
] as const satisfies ProtectedMethod[]

export const importMethods = [...syncMethods, "createManagedCollection"] as const satisfies ProtectedMethod[]

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Import (CMS flow) from an already-loaded preview. The active collection keeps its level (a fresh
 * one becomes Menu Items); the other enabled levels are found by group or created, prefixed.
 */
export async function importMenu(
    active: ManagedCollection,
    stored: StoredSync,
    preview: MenuPreview,
    config: ImportConfig
) {
    // Gate every protected managed-collection operation up front (create + setFields + add/remove +
    // setPluginData). Without this the import would fail partway with a generic error.
    if (!framer.isAllowedTo(...importMethods)) {
        framer.notify("You don’t have permission to create and populate collections in this project.", {
            variant: "error",
        })
        return
    }

    const groupId = stored.groupId ?? crypto.randomUUID()
    const prefix = collectionPrefix(preview, config)
    const collections = await resolveCollections(active, stored.level, groupId, prefix, config, true)
    await runSync(collections, preview, applyConfig(preview, config), groupId, config)
}

/**
 * Resync (Framer's resync button). Re-syncs the whole hierarchy so the down-references stay
 * consistent no matter which collection's button was clicked. Does not create collections.
 */
export async function syncExistingCollection(
    active: ManagedCollection,
    stored: StoredSync
): Promise<{ didSync: boolean }> {
    if (!stored.dataSourceId || !stored.groupId) return { didSync: false }
    if (!stored.branches && stored.sources.length === 0) return { didSync: false }
    if (framer.mode !== "syncManagedCollection") return { didSync: false }
    if (!LEVELS.some(level => LEVEL_SOURCE[level] === stored.dataSourceId)) return { didSync: false }

    // Gate the protected operations runSync performs; surface a clear message rather than failing
    // opaquely mid-sync when the plugin lacks collection permissions.
    if (!framer.isAllowedTo(...syncMethods)) {
        framer.notify("You don’t have permission to sync collections in this project.", { variant: "error" })
        return { didSync: false }
    }

    try {
        const { config, groupId } = stored
        // A branches collection is re-read, so branches added in the CMS are picked up on resync.
        const input: MenuInput = stored.branches
            ? { kind: "collection", branches: stored.branches }
            : { kind: "links", links: stored.sources }
        const preview = await loadMenuPreview(input)
        const prefix = collectionPrefix(preview, config)
        const collections = await resolveCollections(active, stored.level, groupId, prefix, config, false)
        await runSync(collections, preview, applyConfig(preview, config), groupId, config)
        return { didSync: true }
    } catch (error) {
        console.error(error)
        framer.notify("Failed to sync the menus. Check the console for details.", { variant: "error" })
        return { didSync: false }
    }
}

import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Menu → CMS transform (Omega JSON; redro is scraped server-side by the worker).
import {
    slugify,
    transform,
    type MenuCategory,
    type MenuItem,
    type MenuSection,
    type SourceId,
    type TransformResult,
} from "./lib/transform.js"

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
    /** Default currency for the platform (each import is a single venue → one currency). */
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

// A 3-level hierarchy: Categories → Sections → Items. Linked BOTH ways:
//   • up-references   (child → parent)  : Section.category, Item.section, Item.category
//   • down-references (parent → children, multi): Category.sections, Section.items
// The down multi-references let a nested Collection List be sourced directly from
// "Current Item's Sections/Items" — the reliable way to nest when Framer won't offer the
// up-reference as a "Current Item" filter value.
const CATEGORIES_SOURCE = "menu-categories"
const SECTIONS_SOURCE = "menu-sections"
const ITEMS_SOURCE = "menu-items"
const CATEGORIES_COLLECTION_NAME = "Menu Categories"
const SECTIONS_COLLECTION_NAME = "Menu Sections"
const ITEMS_COLLECTION_NAME = "Menu Items"

export const PLUGIN_KEYS = {
    DATA_SOURCE_ID: "dataSourceId",
    CUSTOMER_ID: "customerId",
    IMPORT_CONFIG: "importConfig",
} as const

// ─── Import configuration (what to sync) ─────────────────────────────────────
export interface ItemFlags {
    onlyPopular: boolean
    onlyNew: boolean
    requirePrice: boolean
}

export interface ImportConfig {
    /** Which collections/levels to create. Items is always synced (the active collection). */
    levels: { categories: boolean; sections: boolean }
    /** Category ids to exclude (cascades to their sections + items). Numbers (Omega) or slugs (redro). */
    excludedCategoryIds: SourceId[]
    /** Section ids to exclude (cascades to their items). Numbers (Omega) or strings (redro). */
    excludedSectionIds: SourceId[]
    itemFlags: ItemFlags
}

export const DEFAULT_CONFIG: ImportConfig = {
    levels: { categories: true, sections: true },
    excludedCategoryIds: [],
    excludedSectionIds: [],
    itemFlags: { onlyPopular: false, onlyNew: false, requirePrice: false },
}

export function parseImportConfig(raw: string | null): ImportConfig {
    if (!raw) return DEFAULT_CONFIG
    try {
        const parsed = JSON.parse(raw) as Partial<ImportConfig>
        return {
            levels: { ...DEFAULT_CONFIG.levels, ...parsed.levels },
            excludedCategoryIds: parsed.excludedCategoryIds ?? [],
            excludedSectionIds: parsed.excludedSectionIds ?? [],
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

// ─── Field value builders ───────────────────────────────────────────────────
const str = (value: string): FieldDataInput[string] => ({ type: "string", value })
const num = (value: number): FieldDataInput[string] => ({ type: "number", value })
const bool = (value: boolean): FieldDataInput[string] => ({ type: "boolean", value })
const ref = (value: string): FieldDataInput[string] => ({ type: "collectionReference", value })
const multiRef = (value: string[]): FieldDataInput[string] => ({ type: "multiCollectionReference", value })
const img = (value: string): FieldDataInput[string] => ({ type: "image", value })

// ─── Schema (fields) ─────────────────────────────────────────────────────────
function categoryFields(sectionsCollectionId: string | null): ManagedCollectionFieldInput[] {
    const fields: ManagedCollectionFieldInput[] = [
        { id: "title", name: "Title", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
    // Down-reference: the sections in this category (source a nested list from here).
    if (sectionsCollectionId) {
        fields.push({ id: "sections", name: "Sections", type: "multiCollectionReference", collectionId: sectionsCollectionId })
    }
    return fields
}

function sectionFields(categoriesCollectionId: string | null, itemsCollectionId: string | null): ManagedCollectionFieldInput[] {
    const fields: ManagedCollectionFieldInput[] = [
        { id: "title", name: "Title", type: "string" },
        { id: "comment", name: "Comment", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
    if (categoriesCollectionId) {
        fields.push({ id: "category", name: "Category", type: "collectionReference", collectionId: categoriesCollectionId })
    }
    // Down-reference: the items in this section.
    if (itemsCollectionId) {
        fields.push({ id: "items", name: "Items", type: "multiCollectionReference", collectionId: itemsCollectionId })
    }
    return fields
}

function itemFields(
    categoriesCollectionId: string | null,
    sectionsCollectionId: string | null
): ManagedCollectionFieldInput[] {
    const fields: ManagedCollectionFieldInput[] = [
        { id: "title", name: "Title", type: "string" },
        { id: "description", name: "Description", type: "string" },
        { id: "price", name: "Price", type: "number" },
        { id: "priceNote", name: "Price Note", type: "string" },
        // Currency is one value per import (the venue's) — denormalized onto every item for rendering.
        { id: "currency", name: "Currency", type: "string" },
        // Calories is Plain Text, NOT Number: Framer's CMS rejects optional Number fields
        // ("Optional numbers are not supported in the CMS") and calories are frequently missing.
        { id: "calories", name: "Calories", type: "string" },
        // Item photo (redro item detail pages; Omega venues carry none). Written only when present.
        { id: "image", name: "Image", type: "image" },
        { id: "popular", name: "Popular", type: "boolean" },
        { id: "newItem", name: "New", type: "boolean" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
    if (sectionsCollectionId) {
        fields.push({ id: "section", name: "Section", type: "collectionReference", collectionId: sectionsCollectionId })
    }
    if (categoriesCollectionId) {
        fields.push({ id: "category", name: "Category", type: "collectionReference", collectionId: categoriesCollectionId })
    }
    return fields
}

// ─── Items (rows), keyed on Omega IDs ────────────────────────────────────────
// `childIds` (when provided) fills the down multi-reference; omitted in pass 1 (children
// don't exist yet) and provided in pass 2.
function categoryItems(
    categories: MenuCategory[],
    sectionIdsByCategory: Map<SourceId, string[]> | null
): ManagedCollectionItemInput[] {
    return categories.map((category, index) => {
        const fieldData: FieldDataInput = {
            title: str(category.name),
            sortOrder: num(index + 1),
        }
        if (sectionIdsByCategory) fieldData.sections = multiRef(sectionIdsByCategory.get(category.id) ?? [])
        return { id: String(category.id), slug: slugify(category.name, category.id), draft: false, fieldData }
    })
}

function sectionItems(
    sections: MenuSection[],
    hasCategoryRef: boolean,
    itemIdsBySection: Map<SourceId, string[]> | null
): ManagedCollectionItemInput[] {
    return sections.map(section => {
        const fieldData: FieldDataInput = {
            title: str(section.title),
            comment: str(section.comment),
            sortOrder: num(section.sortOrder),
        }
        if (hasCategoryRef) fieldData.category = ref(String(section.categoryId))
        if (itemIdsBySection) fieldData.items = multiRef(itemIdsBySection.get(section.omegaId) ?? [])
        return { id: String(section.omegaId), slug: section.slug, draft: false, fieldData }
    })
}

function itemItems(
    items: MenuItem[],
    hasCategoryRef: boolean,
    hasSectionRef: boolean,
    currency: string
): ManagedCollectionItemInput[] {
    return items.map(item => {
        const fieldData: FieldDataInput = {
            title: str(item.title),
            description: str(item.description),
            priceNote: str(item.priceNote),
            currency: str(currency),
            popular: bool(item.popular),
            newItem: bool(item.newItem),
            sortOrder: num(item.sortOrder),
        }
        if (typeof item.price === "number") fieldData.price = num(item.price)
        // Calories → Plain Text; redro supplies a number, Omega has none. Omit when absent.
        if (item.calories != null) fieldData.calories = str(String(item.calories))
        // Image → written only when non-empty (never send an empty/null image value).
        if (item.image) fieldData.image = img(item.image)
        if (hasSectionRef) fieldData.section = ref(String(item.sectionOmegaId))
        if (hasCategoryRef) fieldData.category = ref(String(item.categoryId))
        return { id: String(item.omegaId), slug: item.slug, draft: false, fieldData }
    })
}

/** Group child ids under their parent for the down multi-references (order preserved). */
function groupChildIds(sections: MenuSection[], items: MenuItem[]) {
    const sectionIdsByCategory = new Map<SourceId, string[]>()
    for (const section of sections) {
        const list = sectionIdsByCategory.get(section.categoryId) ?? []
        list.push(String(section.omegaId))
        sectionIdsByCategory.set(section.categoryId, list)
    }
    const itemIdsBySection = new Map<SourceId, string[]>()
    for (const item of items) {
        const list = itemIdsBySection.get(item.sectionOmegaId) ?? []
        list.push(String(item.omegaId))
        itemIdsBySection.set(item.sectionOmegaId, list)
    }
    return { sectionIdsByCategory, itemIdsBySection }
}

// ─── Fetch + preview ─────────────────────────────────────────────────────────
export interface MenuPreview {
    /** Canonical source string persisted for resync (Omega customer id or full redro URL). */
    source: string
    platform: Platform
    /** Venue currency (USD Omega / SAR redro), denormalized onto every imported item. */
    currency: string
    brand: string
    categories: MenuCategory[]
    sections: MenuSection[]
    items: MenuItem[]
}

/** Fetch the menu for a source through the worker. Both platforms yield the shared shape:
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

/** Parse the user input, fetch + shape the full menu so the UI can present categories/sections. */
export async function loadMenuPreview(input: string, abortSignal?: AbortSignal): Promise<MenuPreview> {
    const source = parseMenuSource(input)
    const { brand, categories, sections, items } = await fetchMenu(source, abortSignal)
    return { source: source.value, platform: source.platform, currency: source.currency, brand, categories, sections, items }
}

/** Apply the import config: level toggles, category/section exclusions, item flag filters. */
function applyConfig(preview: MenuPreview, config: ImportConfig) {
    const excludedCats = new Set(config.excludedCategoryIds)
    const excludedSecs = new Set(config.excludedSectionIds)

    const keptSections = preview.sections.filter(
        section => !excludedCats.has(section.categoryId) && !excludedSecs.has(section.omegaId)
    )
    const keptSectionIds = new Set(keptSections.map(section => section.omegaId))

    let items = preview.items.filter(item => !excludedCats.has(item.categoryId))
    if (config.levels.sections) items = items.filter(item => keptSectionIds.has(item.sectionOmegaId))
    if (config.itemFlags.onlyPopular) items = items.filter(item => item.popular)
    if (config.itemFlags.onlyNew) items = items.filter(item => item.newItem)
    if (config.itemFlags.requirePrice) items = items.filter(item => item.price !== null)

    const categories = config.levels.categories
        ? preview.categories.filter(category => !excludedCats.has(category.id))
        : []
    const sections = config.levels.sections ? keptSections : []

    return { categories, sections, items }
}

/** Live counts of what the current config would import (for the config screen summary). */
export function previewCounts(preview: MenuPreview, config: ImportConfig) {
    const { categories, sections, items } = applyConfig(preview, config)
    return { categories: categories.length, sections: sections.length, items: items.length }
}

// ─── Collection helpers ──────────────────────────────────────────────────────
async function replaceItems(collection: ManagedCollection, items: ManagedCollectionItemInput[]) {
    const unsynced = new Set(await collection.getItemIds())
    for (const item of items) unsynced.delete(item.id)
    await collection.removeItems(Array.from(unsynced))
    await collection.addItems(items)
}

async function setSyncMeta(collection: ManagedCollection, dataSourceId: string, menuSource: string, config: ImportConfig) {
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, dataSourceId)
    // Stored under the (legacy) "customerId" key for backward compatibility — the value is now the
    // canonical source (Omega customer id or full redro URL), which parseMenuSource round-trips.
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, menuSource)
    await collection.setPluginData(PLUGIN_KEYS.IMPORT_CONFIG, JSON.stringify(config))
}

/** Find a managed collection this plugin uses for the given data source (by plugin data, then name). */
async function findCollectionBySource(source: string, name: string): Promise<ManagedCollection | null> {
    const collections = await framer.getManagedCollections()
    for (const collection of collections) {
        try {
            if ((await collection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)) === source) return collection
        } catch {
            // ignore collections we can't read
        }
    }
    for (const collection of collections) {
        if (collection.name === name) return collection
    }
    return null
}

/** Prefix a collection name with the venue brand: "Tavolina" + "Menu Items" → "Tavolina-Menu Items". */
export function brandedCollectionName(brand: string, base: string): string {
    const prefix = brand.trim()
    return prefix ? `${prefix}-${base}` : base
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

async function getOrCreateCollection(source: string, name: string): Promise<ManagedCollection> {
    return (await findCollectionBySource(source, name)) ?? (await createCollectionWithUniqueName(name))
}

/**
 * Sync the whole hierarchy across the (already-resolved) collections in two passes:
 *   pass 1 — create every item with its scalar fields + up-references (parents first)
 *   pass 2 — fill the parent→children down multi-references (children now all exist)
 * The two passes are required because Category↔Sections and Section↔Items reference each
 * other, so a single pass can't have every referenced item already present.
 */
async function runSync(
    itemsCollection: ManagedCollection,
    categoriesCollection: ManagedCollection | null,
    sectionsCollection: ManagedCollection | null,
    menuSource: string,
    currency: string,
    config: ImportConfig,
    categories: MenuCategory[],
    sections: MenuSection[],
    items: MenuItem[]
) {
    const { sectionIdsByCategory, itemIdsBySection } = groupChildIds(sections, items)
    const hasCat = Boolean(categoriesCollection)
    const hasSec = Boolean(sectionsCollection)

    // Fields (reference fields need their target collection ids).
    if (categoriesCollection) await categoriesCollection.setFields(categoryFields(sectionsCollection?.id ?? null))
    if (sectionsCollection) {
        await sectionsCollection.setFields(sectionFields(categoriesCollection?.id ?? null, itemsCollection.id))
    }
    await itemsCollection.setFields(itemFields(categoriesCollection?.id ?? null, sectionsCollection?.id ?? null))

    // Pass 1 — items + up-references, parents before children, with stale cleanup.
    if (categoriesCollection) await replaceItems(categoriesCollection, categoryItems(categories, null))
    if (sectionsCollection) await replaceItems(sectionsCollection, sectionItems(sections, hasCat, null))
    await replaceItems(itemsCollection, itemItems(items, hasCat, hasSec, currency))

    // Pass 2 — parent→children down multi-references (upsert; every child now exists).
    if (categoriesCollection) {
        await categoriesCollection.addItems(categoryItems(categories, hasSec ? sectionIdsByCategory : null))
    }
    if (sectionsCollection) {
        await sectionsCollection.addItems(sectionItems(sections, hasCat, itemIdsBySection))
    }

    // Metadata (data source + menu source + config) for resync.
    if (categoriesCollection) await setSyncMeta(categoriesCollection, CATEGORIES_SOURCE, menuSource, config)
    if (sectionsCollection) await setSyncMeta(sectionsCollection, SECTIONS_SOURCE, menuSource, config)
    await setSyncMeta(itemsCollection, ITEMS_SOURCE, menuSource, config)
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
 * One-shot import (CMS flow). The active collection — already created + named by Framer — becomes
 * Menu Items; Menu Categories / Menu Sections collections are created (brand-prefixed) for the
 * enabled levels. All linked both ways (up + down refs).
 */
export async function importMenu(itemsCollection: ManagedCollection, menuSource: string, config: ImportConfig) {
    // Gate every protected managed-collection operation up front (create + setFields + add/remove +
    // setPluginData). Without this the import would fail partway with a generic error.
    if (!framer.isAllowedTo(...importMethods)) {
        framer.notify("You don’t have permission to create and populate collections in this project.", {
            variant: "error",
        })
        return
    }

    const preview = await loadMenuPreview(menuSource)
    const base = preview.brand
    const { categories, sections, items } = applyConfig(preview, config)

    const categoriesCollection = config.levels.categories
        ? await getOrCreateCollection(CATEGORIES_SOURCE, brandedCollectionName(base, CATEGORIES_COLLECTION_NAME))
        : null
    const sectionsCollection = config.levels.sections
        ? await getOrCreateCollection(SECTIONS_SOURCE, brandedCollectionName(base, SECTIONS_COLLECTION_NAME))
        : null

    await runSync(
        itemsCollection,
        categoriesCollection,
        sectionsCollection,
        preview.source,
        preview.currency,
        config,
        categories,
        sections,
        items
    )
}

/**
 * Resync (Framer's resync button). Re-syncs the whole hierarchy so the down-references stay
 * consistent no matter which collection's button was clicked. Does not create collections.
 */
export async function syncExistingCollection(
    collection: ManagedCollection,
    previousDataSourceId: string | null,
    previousMenuSource: string | null,
    previousImportConfig: string | null
): Promise<{ didSync: boolean }> {
    if (!previousDataSourceId || !previousMenuSource) return { didSync: false }
    if (framer.mode !== "syncManagedCollection") return { didSync: false }

    const knownSources: string[] = [CATEGORIES_SOURCE, SECTIONS_SOURCE, ITEMS_SOURCE]
    if (!knownSources.includes(previousDataSourceId)) return { didSync: false }

    // Gate the protected operations runSync performs; surface a clear message rather than failing
    // opaquely mid-sync when the plugin lacks collection permissions.
    if (!framer.isAllowedTo(...syncMethods)) {
        framer.notify("You don’t have permission to sync collections in this project.", { variant: "error" })
        return { didSync: false }
    }

    try {
        const config = parseImportConfig(previousImportConfig)
        const preview = await loadMenuPreview(previousMenuSource)
        const { categories, sections, items } = applyConfig(preview, config)

        const categoriesCollection = config.levels.categories
            ? await findCollectionBySource(CATEGORIES_SOURCE, brandedCollectionName(preview.brand, CATEGORIES_COLLECTION_NAME))
            : null
        const sectionsCollection = config.levels.sections
            ? await findCollectionBySource(SECTIONS_SOURCE, brandedCollectionName(preview.brand, SECTIONS_COLLECTION_NAME))
            : null
        // Resolve the Items collection (the active one if this button was its resync).
        const itemsCollection =
            previousDataSourceId === ITEMS_SOURCE
                ? collection
                : await findCollectionBySource(ITEMS_SOURCE, brandedCollectionName(preview.brand, ITEMS_COLLECTION_NAME))

        if (!itemsCollection) {
            framer.notify("“Menu Items” collection not found — re-import from the plugin.", { variant: "error" })
            return { didSync: false }
        }

        await runSync(
            itemsCollection,
            categoriesCollection,
            sectionsCollection,
            preview.source,
            preview.currency,
            config,
            categories,
            sections,
            items
        )
        return { didSync: true }
    } catch (error) {
        console.error(error)
        framer.notify(`Failed to sync menu for “${previousMenuSource}”. Check the console for details.`, {
            variant: "error",
        })
        return { didSync: false }
    }
}

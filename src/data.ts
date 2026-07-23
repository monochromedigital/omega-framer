import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Omega → CMS transform (self-contained copy; kept in sync with the automation project).
import { slugify, transform, type MenuCategory, type MenuItem, type MenuSection } from "./lib/transform.js"

/** Deployed Omega proxy (worker/). Overridable at build time via VITE_WORKER_BASE. */
const WORKER_BASE = import.meta.env.VITE_WORKER_BASE ?? "https://worker-monochrome-dev.vercel.app"

const CUSTOMER_ID_RE = /^[a-z0-9_-]{1,40}$/

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
    /** Omega CATEGORYIDs to exclude (cascades to their sections + items). */
    excludedCategoryIds: number[]
    /** Omega section ids to exclude (cascades to their items). */
    excludedSectionIds: number[]
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

/** Accept a raw customer id ("tavolina") or any Omega/worker URL and return the validated id. */
export function parseCustomerId(input: string): string {
    const trimmed = input.trim()
    const raw = trimmed.includes("/") ? (trimmed.replace(/\/+$/, "").split("/").pop() ?? "") : trimmed
    const id = raw.toLowerCase()
    if (!CUSTOMER_ID_RE.test(id)) {
        throw new Error(`Invalid customer id “${input}”. Expected a slug like “tavolina” or a menu URL.`)
    }
    return id
}

// ─── Field value builders ───────────────────────────────────────────────────
const str = (value: string): FieldDataInput[string] => ({ type: "string", value })
const num = (value: number): FieldDataInput[string] => ({ type: "number", value })
const bool = (value: boolean): FieldDataInput[string] => ({ type: "boolean", value })
const ref = (value: string): FieldDataInput[string] => ({ type: "collectionReference", value })
const multiRef = (value: string[]): FieldDataInput[string] => ({ type: "multiCollectionReference", value })

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
    sectionIdsByCategory: Map<number, string[]> | null
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
    itemIdsBySection: Map<number, string[]> | null
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

function itemItems(items: MenuItem[], hasCategoryRef: boolean, hasSectionRef: boolean): ManagedCollectionItemInput[] {
    return items.map(item => {
        const fieldData: FieldDataInput = {
            title: str(item.title),
            description: str(item.description),
            priceNote: str(item.priceNote),
            popular: bool(item.popular),
            newItem: bool(item.newItem),
            sortOrder: num(item.sortOrder),
        }
        if (typeof item.price === "number") fieldData.price = num(item.price)
        if (hasSectionRef) fieldData.section = ref(String(item.sectionOmegaId))
        if (hasCategoryRef) fieldData.category = ref(String(item.categoryId))
        return { id: String(item.omegaId), slug: item.slug, draft: false, fieldData }
    })
}

/** Group child ids under their parent for the down multi-references (order preserved). */
function groupChildIds(sections: MenuSection[], items: MenuItem[]) {
    const sectionIdsByCategory = new Map<number, string[]>()
    for (const section of sections) {
        const list = sectionIdsByCategory.get(section.categoryId) ?? []
        list.push(String(section.omegaId))
        sectionIdsByCategory.set(section.categoryId, list)
    }
    const itemIdsBySection = new Map<number, string[]>()
    for (const item of items) {
        const list = itemIdsBySection.get(item.sectionOmegaId) ?? []
        list.push(String(item.omegaId))
        itemIdsBySection.set(item.sectionOmegaId, list)
    }
    return { sectionIdsByCategory, itemIdsBySection }
}

// ─── Fetch + preview ─────────────────────────────────────────────────────────
export interface MenuPreview {
    customerId: string
    categories: MenuCategory[]
    sections: MenuSection[]
    items: MenuItem[]
}

async function fetchMenu(customerId: string, abortSignal?: AbortSignal) {
    const response = await fetch(`${WORKER_BASE}/menu/${customerId}`, { signal: abortSignal })
    if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Failed to load menu for “${customerId}” (${response.status}). ${body}`.trim())
    }
    return transform(await response.json())
}

/** Fetch + transform the full menu so the UI can present categories/sections to choose from. */
export async function loadMenuPreview(customerId: string, abortSignal?: AbortSignal): Promise<MenuPreview> {
    const { categories, sections, items } = await fetchMenu(customerId, abortSignal)
    return { customerId, categories, sections, items }
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

async function setSyncMeta(collection: ManagedCollection, source: string, customerId: string, config: ImportConfig) {
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, source)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
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

async function getOrCreateCollection(source: string, name: string): Promise<ManagedCollection> {
    return (await findCollectionBySource(source, name)) ?? (await framer.createManagedCollection(name))
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
    customerId: string,
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
    await replaceItems(itemsCollection, itemItems(items, hasCat, hasSec))

    // Pass 2 — parent→children down multi-references (upsert; every child now exists).
    if (categoriesCollection) {
        await categoriesCollection.addItems(categoryItems(categories, hasSec ? sectionIdsByCategory : null))
    }
    if (sectionsCollection) {
        await sectionsCollection.addItems(sectionItems(sections, hasCat, itemIdsBySection))
    }

    // Metadata (source + customer + config) for resync.
    if (categoriesCollection) await setSyncMeta(categoriesCollection, CATEGORIES_SOURCE, customerId, config)
    if (sectionsCollection) await setSyncMeta(sectionsCollection, SECTIONS_SOURCE, customerId, config)
    await setSyncMeta(itemsCollection, ITEMS_SOURCE, customerId, config)
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
 * One-shot import. The active collection becomes Menu Items; Menu Categories / Menu Sections
 * collections are created for the enabled levels. All linked both ways (up + down refs).
 */
export async function importMenu(itemsCollection: ManagedCollection, customerId: string, config: ImportConfig) {
    const preview = await loadMenuPreview(customerId)
    const { categories, sections, items } = applyConfig(preview, config)

    const categoriesCollection = config.levels.categories
        ? await getOrCreateCollection(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
        : null
    const sectionsCollection = config.levels.sections
        ? await getOrCreateCollection(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
        : null

    await runSync(itemsCollection, categoriesCollection, sectionsCollection, customerId, config, categories, sections, items)
}

/**
 * Resync (Framer's resync button). Re-syncs the whole hierarchy so the down-references stay
 * consistent no matter which collection's button was clicked. Does not create collections.
 */
export async function syncExistingCollection(
    collection: ManagedCollection,
    previousDataSourceId: string | null,
    previousCustomerId: string | null,
    previousImportConfig: string | null
): Promise<{ didSync: boolean }> {
    if (!previousDataSourceId || !previousCustomerId) return { didSync: false }
    if (framer.mode !== "syncManagedCollection") return { didSync: false }
    if (!framer.isAllowedTo(...syncMethods)) return { didSync: false }

    const knownSources: string[] = [CATEGORIES_SOURCE, SECTIONS_SOURCE, ITEMS_SOURCE]
    if (!knownSources.includes(previousDataSourceId)) return { didSync: false }

    try {
        const config = parseImportConfig(previousImportConfig)
        const preview = await loadMenuPreview(previousCustomerId)
        const { categories, sections, items } = applyConfig(preview, config)

        const categoriesCollection = config.levels.categories
            ? await findCollectionBySource(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
            : null
        const sectionsCollection = config.levels.sections
            ? await findCollectionBySource(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
            : null
        // Resolve the Items collection (the active one if this button was its resync).
        const itemsCollection =
            previousDataSourceId === ITEMS_SOURCE
                ? collection
                : await findCollectionBySource(ITEMS_SOURCE, ITEMS_COLLECTION_NAME)

        if (!itemsCollection) {
            framer.notify("“Menu Items” collection not found — re-import from the plugin.", { variant: "error" })
            return { didSync: false }
        }

        await runSync(
            itemsCollection,
            categoriesCollection,
            sectionsCollection,
            previousCustomerId,
            config,
            categories,
            sections,
            items
        )
        return { didSync: true }
    } catch (error) {
        console.error(error)
        framer.notify(`Failed to sync menu for “${previousCustomerId}”. Check the console for details.`, {
            variant: "error",
        })
        return { didSync: false }
    }
}

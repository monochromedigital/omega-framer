import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Shared Omega → CMS transform, reused verbatim from sync/ (see ../../shared/transform.js).
import { slugify, transform, type MenuCategory, type MenuItem, type MenuSection } from "../../shared/transform.js"

/** Deployed Omega proxy (worker/). Overridable at build time via VITE_WORKER_BASE. */
const WORKER_BASE = import.meta.env.VITE_WORKER_BASE ?? "https://worker-monochrome-dev.vercel.app"

const CUSTOMER_ID_RE = /^[a-z0-9_-]{1,40}$/

// A 3-level hierarchy: Categories → Sections → Items, linked by collectionReference fields
// so Framer can nest Collection Lists and filter each inner list by the current outer item.
const CATEGORIES_SOURCE = "menu-categories"
const SECTIONS_SOURCE = "menu-sections"
const ITEMS_SOURCE = "menu-items"
const CATEGORIES_COLLECTION_NAME = "Menu Categories"
const SECTIONS_COLLECTION_NAME = "Menu Sections"

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

function parseConfig(raw: string | null): ImportConfig {
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

// ─── Schema (fields) ─────────────────────────────────────────────────────────
function categoryFields(): ManagedCollectionFieldInput[] {
    return [
        { id: "title", name: "Title", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
}

function sectionFields(categoriesCollectionId: string | null): ManagedCollectionFieldInput[] {
    const fields: ManagedCollectionFieldInput[] = [
        { id: "title", name: "Title", type: "string" },
        { id: "comment", name: "Comment", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
    if (categoriesCollectionId) {
        fields.push({ id: "category", name: "Category", type: "collectionReference", collectionId: categoriesCollectionId })
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
function categoryItems(categories: MenuCategory[]): ManagedCollectionItemInput[] {
    return categories.map((category, index) => ({
        id: String(category.id),
        slug: slugify(category.name, category.id),
        draft: false,
        fieldData: {
            title: str(category.name),
            sortOrder: num(index + 1),
        },
    }))
}

function sectionItems(sections: MenuSection[], hasCategoryRef: boolean): ManagedCollectionItemInput[] {
    return sections.map(section => {
        const fieldData: FieldDataInput = {
            title: str(section.title),
            comment: str(section.comment),
            sortOrder: num(section.sortOrder),
        }
        if (hasCategoryRef) fieldData.category = ref(String(section.categoryId))
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

    // Category/section exclusions cascade regardless of which levels are materialized.
    const keptSections = preview.sections.filter(
        section => !excludedCats.has(section.categoryId) && !excludedSecs.has(section.omegaId)
    )
    const keptSectionIds = new Set(keptSections.map(section => section.omegaId))

    let items = preview.items.filter(item => !excludedCats.has(item.categoryId))
    // When the Sections level exists, only keep items whose section survived.
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
async function upsertItems(collection: ManagedCollection, items: ManagedCollectionItemInput[]) {
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

async function syncCategoriesInto(
    collection: ManagedCollection,
    customerId: string,
    categories: MenuCategory[],
    config: ImportConfig
) {
    await collection.setFields(categoryFields())
    await upsertItems(collection, categoryItems(categories))
    await setSyncMeta(collection, CATEGORIES_SOURCE, customerId, config)
}

async function syncSectionsInto(
    collection: ManagedCollection,
    customerId: string,
    sections: MenuSection[],
    categoriesCollectionId: string | null,
    config: ImportConfig
) {
    await collection.setFields(sectionFields(categoriesCollectionId))
    await upsertItems(collection, sectionItems(sections, Boolean(categoriesCollectionId)))
    await setSyncMeta(collection, SECTIONS_SOURCE, customerId, config)
}

async function syncItemsInto(
    collection: ManagedCollection,
    customerId: string,
    items: MenuItem[],
    categoriesCollectionId: string | null,
    sectionsCollectionId: string | null,
    config: ImportConfig
) {
    await collection.setFields(itemFields(categoriesCollectionId, sectionsCollectionId))
    await upsertItems(collection, itemItems(items, Boolean(categoriesCollectionId), Boolean(sectionsCollectionId)))
    await setSyncMeta(collection, ITEMS_SOURCE, customerId, config)
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
 * One-shot import of the (optionally filtered) hierarchy. The active collection becomes
 * Menu Items; the Menu Categories / Menu Sections collections are created only for the
 * levels enabled in the config. Parents are synced before children so references resolve.
 */
export async function importMenu(itemsCollection: ManagedCollection, customerId: string, config: ImportConfig) {
    const preview = await loadMenuPreview(customerId)
    const { categories, sections, items } = applyConfig(preview, config)

    let categoriesCollectionId: string | null = null
    if (config.levels.categories) {
        const collection = await getOrCreateCollection(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
        await syncCategoriesInto(collection, customerId, categories, config)
        categoriesCollectionId = collection.id
    }

    let sectionsCollectionId: string | null = null
    if (config.levels.sections) {
        const collection = await getOrCreateCollection(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
        await syncSectionsInto(collection, customerId, sections, categoriesCollectionId, config)
        sectionsCollectionId = collection.id
    }

    await syncItemsInto(itemsCollection, customerId, items, categoriesCollectionId, sectionsCollectionId, config)
}

/** Resync one already-configured collection (Framer's resync button, syncManagedCollection mode). */
export async function syncExistingCollection(
    collection: ManagedCollection,
    previousDataSourceId: string | null,
    previousCustomerId: string | null,
    previousImportConfig: string | null
): Promise<{ didSync: boolean }> {
    if (!previousDataSourceId || !previousCustomerId) return { didSync: false }
    if (framer.mode !== "syncManagedCollection") return { didSync: false }
    if (!framer.isAllowedTo(...syncMethods)) return { didSync: false }

    try {
        const config = parseConfig(previousImportConfig)
        const preview = await loadMenuPreview(previousCustomerId)
        const { categories, sections, items } = applyConfig(preview, config)

        if (previousDataSourceId === CATEGORIES_SOURCE) {
            await syncCategoriesInto(collection, previousCustomerId, categories, config)
            return { didSync: true }
        }

        if (previousDataSourceId === SECTIONS_SOURCE) {
            const categoriesCollection = config.levels.categories
                ? await findCollectionBySource(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
                : null
            await syncSectionsInto(collection, previousCustomerId, sections, categoriesCollection?.id ?? null, config)
            return { didSync: true }
        }

        if (previousDataSourceId === ITEMS_SOURCE) {
            const categoriesCollection = config.levels.categories
                ? await findCollectionBySource(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
                : null
            const sectionsCollection = config.levels.sections
                ? await findCollectionBySource(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
                : null
            await syncItemsInto(
                collection,
                previousCustomerId,
                items,
                categoriesCollection?.id ?? null,
                sectionsCollection?.id ?? null,
                config
            )
            return { didSync: true }
        }

        return { didSync: false }
    } catch (error) {
        console.error(error)
        framer.notify(`Failed to sync menu for “${previousCustomerId}”. Check the console for details.`, {
            variant: "error",
        })
        return { didSync: false }
    }
}

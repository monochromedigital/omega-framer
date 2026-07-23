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
} as const

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
    // Reference up to the parent Category so Sections can be nested under Categories.
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
    // Reference up to the parent Section (nest items under sections) …
    if (sectionsCollectionId) {
        fields.push({ id: "section", name: "Section", type: "collectionReference", collectionId: sectionsCollectionId })
    }
    // … and directly to the Category (nest items under categories, or flat-filter by category).
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
        // Reference value = the category's item id, which is its Omega CATEGORYID (see categoryItems).
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
        // Price is nullable in the POS; leave the field empty rather than writing null.
        if (typeof item.price === "number") fieldData.price = num(item.price)
        // Reference values = the parent items' ids, which are their Omega IDs.
        if (hasSectionRef) fieldData.section = ref(String(item.sectionOmegaId))
        if (hasCategoryRef) fieldData.category = ref(String(item.categoryId))
        return { id: String(item.omegaId), slug: item.slug, draft: false, fieldData }
    })
}

// ─── Fetch ────────────────────────────────────────────────────────────────--
async function fetchMenu(customerId: string, abortSignal?: AbortSignal) {
    const response = await fetch(`${WORKER_BASE}/menu/${customerId}`, { signal: abortSignal })
    if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Failed to load menu for “${customerId}” (${response.status}). ${body}`.trim())
    }
    return transform(await response.json())
}

// ─── Collection helpers ──────────────────────────────────────────────────────
async function upsertItems(collection: ManagedCollection, items: ManagedCollectionItemInput[]) {
    const unsynced = new Set(await collection.getItemIds())
    for (const item of items) unsynced.delete(item.id)
    await collection.removeItems(Array.from(unsynced))
    await collection.addItems(items)
}

async function syncCategoriesInto(collection: ManagedCollection, customerId: string, categories: MenuCategory[]) {
    await collection.setFields(categoryFields())
    await upsertItems(collection, categoryItems(categories))
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, CATEGORIES_SOURCE)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
}

async function syncSectionsInto(
    collection: ManagedCollection,
    customerId: string,
    sections: MenuSection[],
    categoriesCollectionId: string | null
) {
    await collection.setFields(sectionFields(categoriesCollectionId))
    await upsertItems(collection, sectionItems(sections, Boolean(categoriesCollectionId)))
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, SECTIONS_SOURCE)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
}

async function syncItemsInto(
    collection: ManagedCollection,
    customerId: string,
    items: MenuItem[],
    categoriesCollectionId: string | null,
    sectionsCollectionId: string | null
) {
    await collection.setFields(itemFields(categoriesCollectionId, sectionsCollectionId))
    await upsertItems(collection, itemItems(items, Boolean(categoriesCollectionId), Boolean(sectionsCollectionId)))
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, ITEMS_SOURCE)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
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
 * One-shot import of the whole 3-level hierarchy. The active collection becomes Menu Items;
 * linked Menu Categories and Menu Sections collections are auto-created/reused. Parents are
 * synced before children so the collectionReference values resolve.
 */
export async function importMenu(itemsCollection: ManagedCollection, customerId: string) {
    const { categories, sections, items } = await fetchMenu(customerId)

    const categoriesCollection = await getOrCreateCollection(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
    await syncCategoriesInto(categoriesCollection, customerId, categories)

    const sectionsCollection = await getOrCreateCollection(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
    await syncSectionsInto(sectionsCollection, customerId, sections, categoriesCollection.id)

    await syncItemsInto(itemsCollection, customerId, items, categoriesCollection.id, sectionsCollection.id)
}

/** Resync one already-configured collection (Framer's resync button, syncManagedCollection mode). */
export async function syncExistingCollection(
    collection: ManagedCollection,
    previousDataSourceId: string | null,
    previousCustomerId: string | null
): Promise<{ didSync: boolean }> {
    if (!previousDataSourceId || !previousCustomerId) return { didSync: false }
    if (framer.mode !== "syncManagedCollection") return { didSync: false }
    if (!framer.isAllowedTo(...syncMethods)) return { didSync: false }

    try {
        const { categories, sections, items } = await fetchMenu(previousCustomerId)

        if (previousDataSourceId === CATEGORIES_SOURCE) {
            await syncCategoriesInto(collection, previousCustomerId, categories)
            return { didSync: true }
        }

        if (previousDataSourceId === SECTIONS_SOURCE) {
            const categoriesCollection = await findCollectionBySource(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
            await syncSectionsInto(collection, previousCustomerId, sections, categoriesCollection?.id ?? null)
            return { didSync: true }
        }

        if (previousDataSourceId === ITEMS_SOURCE) {
            const categoriesCollection = await findCollectionBySource(CATEGORIES_SOURCE, CATEGORIES_COLLECTION_NAME)
            const sectionsCollection = await findCollectionBySource(SECTIONS_SOURCE, SECTIONS_COLLECTION_NAME)
            if (!sectionsCollection) {
                framer.notify("Linked “Menu Sections” collection not found; items will sync without a section link.", {
                    variant: "warning",
                })
            }
            await syncItemsInto(
                collection,
                previousCustomerId,
                items,
                categoriesCollection?.id ?? null,
                sectionsCollection?.id ?? null
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

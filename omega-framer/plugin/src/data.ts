import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Shared Omega → CMS transform, reused verbatim from sync/ (see ../../shared/transform.js).
import { transform, type MenuItem, type MenuSection } from "../../shared/transform.js"

/** Deployed Omega proxy (worker/). Overridable at build time via VITE_WORKER_BASE. */
const WORKER_BASE = import.meta.env.VITE_WORKER_BASE ?? "https://worker-monochrome-dev.vercel.app"

const CUSTOMER_ID_RE = /^[a-z0-9_-]{1,40}$/

const SECTIONS_SOURCE = "menu-sections"
const ITEMS_SOURCE = "menu-items"
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
const enumVal = (value: string): FieldDataInput[string] => ({ type: "enum", value })
const ref = (value: string): FieldDataInput[string] => ({ type: "collectionReference", value })

const CATEGORY_CASES = [
    { id: "food", name: "Food" },
    { id: "beverages", name: "Beverages" },
] as const

// ─── Schema + item shaping (pure) ────────────────────────────────────────────
function sectionFields(): ManagedCollectionFieldInput[] {
    return [
        { id: "title", name: "Title", type: "string" },
        { id: "category", name: "Category", type: "enum", cases: [...CATEGORY_CASES] },
        { id: "comment", name: "Comment", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]
}

function itemFields(sectionsCollectionId: string | null): ManagedCollectionFieldInput[] {
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
    return fields
}

function sectionItems(sections: MenuSection[]): ManagedCollectionItemInput[] {
    return sections.map(section => ({
        id: String(section.omegaId),
        slug: section.slug,
        draft: false,
        fieldData: {
            title: str(section.title),
            category: enumVal(section.category.toLowerCase() === "beverages" ? "beverages" : "food"),
            comment: str(section.comment),
            sortOrder: num(section.sortOrder),
        },
    }))
}

function itemItems(items: MenuItem[], hasSectionRef: boolean): ManagedCollectionItemInput[] {
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
        // Reference value = the section's item id, which is its Omega ID (see sectionItems).
        if (hasSectionRef) fieldData.section = ref(String(item.sectionOmegaId))
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

async function syncSectionsInto(collection: ManagedCollection, customerId: string, sections: MenuSection[]) {
    await collection.setFields(sectionFields())
    await upsertItems(collection, sectionItems(sections))
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, SECTIONS_SOURCE)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
}

async function syncItemsInto(
    collection: ManagedCollection,
    customerId: string,
    items: MenuItem[],
    sectionsCollectionId: string | null
) {
    await collection.setFields(itemFields(sectionsCollectionId))
    await upsertItems(collection, itemItems(items, Boolean(sectionsCollectionId)))
    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, ITEMS_SOURCE)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, customerId)
}

/** Find a managed collection this plugin uses for the given data source (by plugin data, then name). */
async function findSectionsCollection(): Promise<ManagedCollection | null> {
    const collections = await framer.getManagedCollections()
    for (const collection of collections) {
        try {
            if ((await collection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)) === SECTIONS_SOURCE) return collection
        } catch {
            // ignore collections we can't read
        }
    }
    for (const collection of collections) {
        if (collection.name === SECTIONS_COLLECTION_NAME) return collection
    }
    return null
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
 * One-shot import: populate the active collection as Menu Items and auto-create/reuse a
 * linked Menu Sections collection. Sections are synced first so items can reference them.
 */
export async function importMenu(itemsCollection: ManagedCollection, customerId: string) {
    const { sections, items } = await fetchMenu(customerId)

    const sectionsCollection = (await findSectionsCollection()) ?? (await framer.createManagedCollection(SECTIONS_COLLECTION_NAME))
    await syncSectionsInto(sectionsCollection, customerId, sections)

    await syncItemsInto(itemsCollection, customerId, items, sectionsCollection.id)
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
        const { sections, items } = await fetchMenu(previousCustomerId)

        if (previousDataSourceId === SECTIONS_SOURCE) {
            await syncSectionsInto(collection, previousCustomerId, sections)
            return { didSync: true }
        }

        if (previousDataSourceId === ITEMS_SOURCE) {
            const sectionsCollection = await findSectionsCollection()
            if (!sectionsCollection) {
                framer.notify("Linked “Menu Sections” collection not found; items will sync without a section link.", {
                    variant: "warning",
                })
            }
            await syncItemsInto(collection, previousCustomerId, items, sectionsCollection?.id ?? null)
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

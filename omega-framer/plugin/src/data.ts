import {
    type FieldDataInput,
    framer,
    type ManagedCollection,
    type ManagedCollectionFieldInput,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
// Shared Omega → CMS transform, reused verbatim from sync/ (see ../../shared/transform.js).
import { transform } from "../../shared/transform.js"

/** Deployed Omega proxy (worker/). Overridable at build time via VITE_WORKER_BASE. */
const WORKER_BASE = import.meta.env.VITE_WORKER_BASE ?? "https://worker-monochrome-dev.vercel.app"

const CUSTOMER_ID_RE = /^[a-z0-9_-]{1,40}$/

export const PLUGIN_KEYS = {
    DATA_SOURCE_ID: "dataSourceId",
    CUSTOMER_ID: "customerId",
} as const

export const dataSourceOptions = [
    { id: "menu-sections", name: "Menu Sections" },
    { id: "menu-items", name: "Menu Items" },
] as const

export type DataSourceId = (typeof dataSourceOptions)[number]["id"]

/** A single CMS item with a plugin-controlled id (= the Omega ID) and a stable slug. */
export interface DataItem {
    id: string
    slug: string
    fieldData: FieldDataInput
}

export interface DataSource {
    id: DataSourceId
    customerId: string
    fields: ManagedCollectionFieldInput[]
    items: DataItem[]
}

/** Accept a raw customer id ("tavolina") or any Omega/worker URL and return the validated id. */
export function parseCustomerId(input: string): string {
    const trimmed = input.trim()
    // Last non-empty path segment of a URL, or the raw string.
    const raw = trimmed.includes("/") ? (trimmed.replace(/\/+$/, "").split("/").pop() ?? "") : trimmed
    const id = raw.toLowerCase()
    if (!CUSTOMER_ID_RE.test(id)) {
        throw new Error(`Invalid customer id “${input}”. Expected a slug like “tavolina” or a menu URL.`)
    }
    return id
}

const str = (value: string): FieldDataInput[string] => ({ type: "string", value })
const num = (value: number): FieldDataInput[string] => ({ type: "number", value })
const bool = (value: boolean): FieldDataInput[string] => ({ type: "boolean", value })
const enumVal = (value: string): FieldDataInput[string] => ({ type: "enum", value })
const ref = (value: string): FieldDataInput[string] => ({ type: "collectionReference", value })

const CATEGORY_CASES = [
    { id: "food", name: "Food" },
    { id: "beverages", name: "Beverages" },
] as const

function buildSections(customerId: string, sections: ReturnType<typeof transform>["sections"]): DataSource {
    const fields: ManagedCollectionFieldInput[] = [
        { id: "title", name: "Title", type: "string" },
        { id: "category", name: "Category", type: "enum", cases: [...CATEGORY_CASES] },
        { id: "comment", name: "Comment", type: "string" },
        { id: "sortOrder", name: "Sort Order", type: "number" },
    ]

    const items: DataItem[] = sections.map(section => ({
        id: String(section.omegaId),
        slug: section.slug,
        fieldData: {
            title: str(section.title),
            category: enumVal(section.category.toLowerCase() === "beverages" ? "beverages" : "food"),
            comment: str(section.comment),
            sortOrder: num(section.sortOrder),
        },
    }))

    return { id: "menu-sections", customerId, fields, items }
}

async function buildItems(customerId: string, menuItems: ReturnType<typeof transform>["items"]): Promise<DataSource> {
    // Items reference Sections. Find the already-synced Menu Sections collection to link to.
    const sectionsCollectionId = await findManagedCollectionId("menu-sections")
    if (!sectionsCollectionId) {
        framer.notify("Sync “Menu Sections” first so items can link to their section.", { variant: "warning" })
    }

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

    const items: DataItem[] = menuItems.map(item => {
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
        // Reference value = the section's item id, which is its Omega ID (see buildSections).
        if (sectionsCollectionId) fieldData.section = ref(String(item.sectionOmegaId))
        return { id: String(item.omegaId), slug: item.slug, fieldData }
    })

    return { id: "menu-items", customerId, fields, items }
}

/** Fetch the menu from the worker proxy and shape it into the requested data source. */
export async function getDataSource(
    dataSourceId: DataSourceId,
    customerId: string,
    abortSignal?: AbortSignal
): Promise<DataSource> {
    const response = await fetch(`${WORKER_BASE}/menu/${customerId}`, { signal: abortSignal })
    if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Failed to load menu for “${customerId}” (${response.status}). ${body}`.trim())
    }
    const raw = await response.json()
    const { sections, items } = transform(raw)

    if (dataSourceId === "menu-sections") return buildSections(customerId, sections)
    return buildItems(customerId, items)
}

/** Look up a managed collection this plugin previously synced for the given data source. */
async function findManagedCollectionId(dataSourceId: DataSourceId): Promise<string | null> {
    const collections = await framer.getCollections()
    for (const collection of collections) {
        if (!("getPluginData" in collection)) continue
        try {
            const id = await collection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)
            if (id === dataSourceId) return collection.id
        } catch {
            // Not a managed collection we control; ignore.
        }
    }
    return null
}

export function mergeFieldsWithExistingFields(
    sourceFields: readonly ManagedCollectionFieldInput[],
    existingFields: readonly ManagedCollectionFieldInput[]
): ManagedCollectionFieldInput[] {
    return sourceFields.map(sourceField => {
        const existingField = existingFields.find(existingField => existingField.id === sourceField.id)
        if (existingField) {
            return { ...sourceField, name: existingField.name }
        }
        return sourceField
    })
}

export async function syncCollection(
    collection: ManagedCollection,
    dataSource: DataSource,
    fields: readonly ManagedCollectionFieldInput[]
) {
    const allowedFieldIds = new Set(fields.map(field => field.id))
    const items: ManagedCollectionItemInput[] = []
    const unsyncedItems = new Set(await collection.getItemIds())

    for (const item of dataSource.items) {
        unsyncedItems.delete(item.id)

        const fieldData: FieldDataInput = {}
        for (const [fieldId, value] of Object.entries(item.fieldData)) {
            if (!allowedFieldIds.has(fieldId)) continue // field ignored in the mapping UI
            fieldData[fieldId] = value
        }

        items.push({ id: item.id, slug: item.slug, draft: false, fieldData })
    }

    await collection.removeItems(Array.from(unsyncedItems))
    await collection.addItems(items)

    await collection.setPluginData(PLUGIN_KEYS.DATA_SOURCE_ID, dataSource.id)
    await collection.setPluginData(PLUGIN_KEYS.CUSTOMER_ID, dataSource.customerId)
}

export const syncMethods = [
    "ManagedCollection.removeItems",
    "ManagedCollection.addItems",
    "ManagedCollection.setPluginData",
] as const satisfies ProtectedMethod[]

export async function syncExistingCollection(
    collection: ManagedCollection,
    previousDataSourceId: string | null,
    previousCustomerId: string | null
): Promise<{ didSync: boolean }> {
    if (!previousDataSourceId || !previousCustomerId) {
        return { didSync: false }
    }

    if (framer.mode !== "syncManagedCollection") {
        return { didSync: false }
    }

    if (!framer.isAllowedTo(...syncMethods)) {
        return { didSync: false }
    }

    const isKnownSource = dataSourceOptions.some(option => option.id === previousDataSourceId)
    if (!isKnownSource) {
        return { didSync: false }
    }

    try {
        const dataSource = await getDataSource(previousDataSourceId as DataSourceId, previousCustomerId)
        const existingFields = await collection.getFields()
        await syncCollection(collection, dataSource, existingFields)
        return { didSync: true }
    } catch (error) {
        console.error(error)
        framer.notify(`Failed to sync “${previousDataSourceId}” for “${previousCustomerId}”. Check the console.`, {
            variant: "error",
        })
        return { didSync: false }
    }
}

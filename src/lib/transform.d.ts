/** Type declarations for the shared (plain-JS) Omega → CMS transform module.
 *
 * These interfaces are the UNIFIED menu shape the plugin's importer consumes. Omega
 * (this file's `transform`) produces numeric ids; the redro adapter (fetched via the
 * worker) produces string ids (category slugs, section keys, item UUIDs) and populates
 * `calories`. `SourceId` is `number | string` so both platforms drop into one pipeline. */

/** A menu item / section / category id: Omega numbers or redro UUID/slug strings. */
export type SourceId = number | string

export interface MenuCategory {
    id: SourceId
    name: string
}

export interface MenuSection {
    omegaId: SourceId
    title: string
    slug: string
    categoryId: SourceId
    category: string
    comment: string
    sortOrder: number
}

export interface MenuItem {
    omegaId: SourceId
    title: string
    slug: string
    description: string
    price: number | null
    priceNote: string
    sectionOmegaId: SourceId
    categoryId: SourceId
    category: string
    popular: boolean
    newItem: boolean
    /** Item photo URL ("" when none). Omega venues carry no photos; redro fills from detail pages. */
    image: string
    /** Calories as a number (redro); absent for Omega (its values are all 0 → left empty). */
    calories?: number | null
    sortOrder: number
}

export interface TransformResult {
    brand: string
    categories: MenuCategory[]
    sections: MenuSection[]
    items: MenuItem[]
}

export function slugify(text: unknown, id: number | string): string
export function clean(value: unknown): string
export function itemImage(item: { PIC?: string | null; pictures?: unknown }): string
export function splitPriceNote(item: { ITEMDESCRIPTION?: string | null; PRICE?: number | null }): {
    description: string
    priceNote: string
}
export function transform(data: unknown): TransformResult

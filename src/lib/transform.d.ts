/** Type declarations for the shared (plain-JS) Omega → CMS transform module. */

export interface MenuCategory {
    id: number
    name: string
}

export interface MenuSection {
    omegaId: number
    title: string
    slug: string
    categoryId: number
    category: string
    comment: string
    sortOrder: number
}

export interface MenuItem {
    omegaId: number
    title: string
    slug: string
    description: string
    price: number | null
    priceNote: string
    sectionOmegaId: number
    categoryId: number
    category: string
    popular: boolean
    newItem: boolean
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
export function splitPriceNote(item: { ITEMDESCRIPTION?: string | null; PRICE?: number | null }): {
    description: string
    priceNote: string
}
export function transform(data: unknown): TransformResult

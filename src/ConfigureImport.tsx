import { framer, type ManagedCollection, useIsAllowedTo } from "@framer/plugin"
import { useMemo, useState } from "react"
import { type ImportConfig, importMenu, importMethods, type MenuPreview, previewCounts } from "./data"

interface ConfigureImportProps {
    collection: ManagedCollection
    preview: MenuPreview
    initialConfig: ImportConfig
    onBack: () => void
}

export function ConfigureImport({ collection, preview, initialConfig, onBack }: ConfigureImportProps) {
    const [config, setConfig] = useState<ImportConfig>(initialConfig)
    const [isImporting, setIsImporting] = useState(false)
    const isAllowed = useIsAllowedTo(...importMethods)

    const excludedCats = useMemo(() => new Set(config.excludedCategoryIds), [config.excludedCategoryIds])
    const excludedSecs = useMemo(() => new Set(config.excludedSectionIds), [config.excludedSectionIds])
    const counts = useMemo(() => previewCounts(preview, config), [preview, config])

    const setLevel = (key: "categories" | "sections", value: boolean) =>
        setConfig(c => ({ ...c, levels: { ...c.levels, [key]: value } }))

    const toggleCategory = (id: number) =>
        setConfig(c => {
            const next = new Set(c.excludedCategoryIds)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return { ...c, excludedCategoryIds: Array.from(next) }
        })

    const toggleSection = (id: number) =>
        setConfig(c => {
            const next = new Set(c.excludedSectionIds)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return { ...c, excludedSectionIds: Array.from(next) }
        })

    const setFlag = (key: keyof ImportConfig["itemFlags"], value: boolean) =>
        setConfig(c => ({ ...c, itemFlags: { ...c.itemFlags, [key]: value } }))

    // Sections grouped under their category for the checklist.
    const grouped = useMemo(() => {
        return preview.categories.map(category => ({
            category,
            sections: preview.sections.filter(section => section.categoryId === category.id),
        }))
    }, [preview])

    const handleImport = async () => {
        try {
            setIsImporting(true)
            await importMenu(collection, preview.customerId, config)
            framer.closePlugin("Menu imported successfully", { variant: "success" })
        } catch (error) {
            console.error(error)
            framer.notify(error instanceof Error ? error.message : "Failed to import the menu.", { variant: "error" })
            setIsImporting(false)
        }
    }

    return (
        <main className="framer-hide-scrollbar configure">
            <div className="config-scroll">
                <section>
                    <h3>Levels</h3>
                    <label className="row">
                        <span>Menu Categories</span>
                        <input
                            type="checkbox"
                            checked={config.levels.categories}
                            onChange={e => setLevel("categories", e.target.checked)}
                        />
                    </label>
                    <label className="row">
                        <span>Menu Sections</span>
                        <input
                            type="checkbox"
                            checked={config.levels.sections}
                            onChange={e => setLevel("sections", e.target.checked)}
                        />
                    </label>
                    <label className="row muted">
                        <span>Menu Items</span>
                        <input type="checkbox" checked readOnly disabled />
                    </label>
                </section>

                <section>
                    <h3>Categories</h3>
                    {preview.categories.map(category => (
                        <label key={category.id} className="row">
                            <span>{category.name}</span>
                            <input
                                type="checkbox"
                                checked={!excludedCats.has(category.id)}
                                onChange={() => toggleCategory(category.id)}
                            />
                        </label>
                    ))}
                </section>

                <section>
                    <h3>Sections</h3>
                    {grouped.map(({ category, sections }) => {
                        const categoryExcluded = excludedCats.has(category.id)
                        return (
                            <div key={category.id} className="group">
                                <div className="group-label">{category.name}</div>
                                {sections.map(section => (
                                    <label key={section.omegaId} className={`row ${categoryExcluded ? "muted" : ""}`}>
                                        <span>{section.title}</span>
                                        <input
                                            type="checkbox"
                                            disabled={categoryExcluded}
                                            checked={!categoryExcluded && !excludedSecs.has(section.omegaId)}
                                            onChange={() => toggleSection(section.omegaId)}
                                        />
                                    </label>
                                ))}
                            </div>
                        )
                    })}
                </section>

                <section>
                    <h3>Item filters</h3>
                    <label className="row">
                        <span>Only popular items</span>
                        <input
                            type="checkbox"
                            checked={config.itemFlags.onlyPopular}
                            onChange={e => setFlag("onlyPopular", e.target.checked)}
                        />
                    </label>
                    <label className="row">
                        <span>Only new items</span>
                        <input
                            type="checkbox"
                            checked={config.itemFlags.onlyNew}
                            onChange={e => setFlag("onlyNew", e.target.checked)}
                        />
                    </label>
                    <label className="row">
                        <span>Skip items with no price</span>
                        <input
                            type="checkbox"
                            checked={config.itemFlags.requirePrice}
                            onChange={e => setFlag("requirePrice", e.target.checked)}
                        />
                    </label>
                </section>
            </div>

            <footer>
                <p className="summary">
                    {config.levels.categories ? `${counts.categories} categories · ` : ""}
                    {config.levels.sections ? `${counts.sections} sections · ` : ""}
                    {counts.items} items
                </p>
                <div className="actions">
                    <button type="button" className="secondary" onClick={onBack} disabled={isImporting}>
                        Back
                    </button>
                    <button
                        type="button"
                        onClick={handleImport}
                        disabled={isImporting || !isAllowed || counts.items === 0}
                        title={isAllowed ? undefined : "Insufficient permissions"}
                    >
                        {isImporting ? <div className="framer-spinner" /> : "Import"}
                    </button>
                </div>
            </footer>
        </main>
    )
}

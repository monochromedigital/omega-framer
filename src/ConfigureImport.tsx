import { framer, type ManagedCollection, useIsAllowedTo } from "@framer/plugin"
import { useEffect, useMemo, useRef, useState } from "react"
import {
    brandedCollectionName,
    collectionPrefix,
    displayName,
    type ImportConfig,
    importMenu,
    importMethods,
    LEVEL_COLLECTION_NAME,
    locationName,
    type MenuPreview,
    previewCounts,
    scopedCategoryId,
    scopedSectionId,
    type StoredSync,
} from "./data"

interface ConfigureImportProps {
    collection: ManagedCollection
    stored: StoredSync
    preview: MenuPreview
    initialConfig: ImportConfig
    onBack: () => void
}

type ToggleLevel = keyof ImportConfig["levels"]
const TOGGLE_LEVELS: readonly ToggleLevel[] = ["locations", "categories", "sections"]

const PLATFORM_LABEL = { omega: "Omega", redro: "redro" } as const

export function ConfigureImport({ collection, stored, preview, initialConfig, onBack }: ConfigureImportProps) {
    const [config, setConfig] = useState<ImportConfig>(initialConfig)
    const [isImporting, setIsImporting] = useState(false)
    const isAllowed = useIsAllowedTo(...importMethods)

    // Don't touch state after the plugin/UI unmounts mid-import.
    const mountedRef = useRef(true)
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const excludedCats = useMemo(() => new Set(config.excludedCategoryIds), [config.excludedCategoryIds])
    const excludedSecs = useMemo(() => new Set(config.excludedSectionIds), [config.excludedSectionIds])
    const counts = useMemo(() => previewCounts(preview, config), [preview, config])

    // The active collection keeps its level, but the plugin can't rename it (Framer set its name, no
    // rename API). If it doesn't match the {{Prefix}}-{{Collection}} convention, suggest a manual
    // rename in the CMS so it lines up with the collections the plugin creates.
    const prefix = collectionPrefix(preview, config)
    const expectedName = brandedCollectionName(prefix, LEVEL_COLLECTION_NAME[stored.level])
    const showRenameHint = prefix.trim() !== "" && collection.name !== expectedName

    const setLevel = (key: ToggleLevel, value: boolean) =>
        setConfig(c => ({ ...c, levels: { ...c.levels, [key]: value } }))

    const setLocationName = (key: string, value: string) =>
        setConfig(c => ({ ...c, locationNames: { ...c.locationNames, [key]: value } }))

    const toggle = (list: "excludedCategoryIds" | "excludedSectionIds", id: string) =>
        setConfig(c => {
            const next = new Set(c[list])
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return { ...c, [list]: Array.from(next) }
        })

    const setFlag = (key: keyof ImportConfig["itemFlags"], value: boolean) =>
        setConfig(c => ({ ...c, itemFlags: { ...c.itemFlags, [key]: value } }))

    const handleImport = async () => {
        try {
            setIsImporting(true)
            await importMenu(collection, stored, preview, config)
            if (!mountedRef.current) return
            framer.closePlugin("Menu imported successfully", { variant: "success" })
        } catch (error) {
            if (!mountedRef.current) return // unmounted mid-import — don't setState
            console.error(error)
            framer.notify(error instanceof Error ? error.message : "Failed to import the menu.", { variant: "error" })
            setIsImporting(false)
        }
    }

    const summary = [
        config.levels.locations ? `${counts.locations} locations` : null,
        config.levels.categories ? `${counts.categories} categories` : null,
        config.levels.sections ? `${counts.sections} sections` : null,
        `${counts.items} items`,
    ]
        .filter(Boolean)
        .join(" · ")

    return (
        <main className="framer-hide-scrollbar configure">
            <div className="config-scroll">
                <section>
                    <h3>Collections</h3>
                    <label className="row">
                        <span>Name prefix</span>
                        <input
                            type="text"
                            value={prefix}
                            placeholder="e.g. Amar"
                            onChange={e => setConfig(c => ({ ...c, collectionPrefix: e.target.value }))}
                        />
                    </label>
                    {TOGGLE_LEVELS.map(level => {
                        // The collection the plugin was opened from always keeps its own level.
                        const locked = stored.level === level
                        return (
                            <label key={level} className={`row ${locked ? "muted" : ""}`}>
                                <span>{LEVEL_COLLECTION_NAME[level]}</span>
                                <input
                                    type="checkbox"
                                    checked={locked || config.levels[level]}
                                    disabled={locked}
                                    onChange={e => setLevel(level, e.target.checked)}
                                />
                            </label>
                        )
                    })}
                    <label className="row muted">
                        <span>Menu Items</span>
                        <input type="checkbox" checked readOnly disabled />
                    </label>
                    {showRenameHint && (
                        <p className="hint">
                            Tip: rename this collection to <code>{expectedName}</code> in the CMS to match the others.
                        </p>
                    )}
                </section>

                <section>
                    <h3>Locations</h3>
                    {preview.locations.map(location => (
                        <div key={location.key} className="location">
                            {location.branch ? (
                                // Names come from the branches collection — edit them in the CMS.
                                <span className="location-name">{location.branch.name}</span>
                            ) : (
                                <input
                                    type="text"
                                    value={config.locationNames[location.key] ?? location.brand}
                                    placeholder={location.brand || location.key}
                                    onChange={e => setLocationName(location.key, e.target.value)}
                                />
                            )}
                            <span className="meta">
                                {PLATFORM_LABEL[location.platform]} · {location.items.length} items ·{" "}
                                {location.currency}
                            </span>
                        </div>
                    ))}
                    {preview.branchesCollectionName && (
                        <p className="hint">
                            From <code>{preview.branchesCollectionName}</code> — each location links back to its branch.
                            {preview.skippedBranches > 0 &&
                                ` ${preview.skippedBranches} skipped (draft or no menu link).`}
                        </p>
                    )}
                </section>

                <section>
                    <h3>Categories &amp; sections</h3>
                    {preview.locations.map(location => (
                        <div key={location.key} className="group">
                            <div className="group-label">{locationName(location, config)}</div>
                            {location.categories.map(category => {
                                const categoryId = scopedCategoryId(location, category)
                                const categoryExcluded = excludedCats.has(categoryId)
                                return (
                                    <div key={categoryId}>
                                        <label className="row">
                                            <span>{displayName(category.name, location, config)}</span>
                                            <input
                                                type="checkbox"
                                                checked={!categoryExcluded}
                                                onChange={() => toggle("excludedCategoryIds", categoryId)}
                                            />
                                        </label>
                                        {location.sections
                                            .filter(section => section.categoryId === category.id)
                                            .map(section => {
                                                const sectionId = scopedSectionId(location, section)
                                                return (
                                                    <label
                                                        key={sectionId}
                                                        className={`row indent ${categoryExcluded ? "muted" : ""}`}
                                                    >
                                                        <span>{displayName(section.title, location, config)}</span>
                                                        <input
                                                            type="checkbox"
                                                            disabled={categoryExcluded}
                                                            checked={!categoryExcluded && !excludedSecs.has(sectionId)}
                                                            onChange={() => toggle("excludedSectionIds", sectionId)}
                                                        />
                                                    </label>
                                                )
                                            })}
                                    </div>
                                )
                            })}
                        </div>
                    ))}
                </section>

                <section>
                    <h3>Item filters</h3>
                    <label
                        className="row"
                        title="Title Case every name, remove branch codes like “-SS”, spell out BTL/GLS/PCS"
                    >
                        <span>Clean up names</span>
                        <input
                            type="checkbox"
                            checked={config.cleanNames}
                            onChange={e => setConfig(c => ({ ...c, cleanNames: e.target.checked }))}
                        />
                    </label>
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
                <p className="summary">{summary}</p>
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

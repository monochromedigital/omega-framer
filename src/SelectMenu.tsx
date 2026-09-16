import { framer } from "@framer/plugin"
import { useEffect, useRef, useState } from "react"
import {
    type BranchCollectionOption,
    type BranchesSource,
    guessField,
    listBranchCollections,
    loadMenuPreview,
    type MenuInput,
    type MenuPreview,
    PROVIDERS,
    splitMenuInput,
} from "./data"

interface SelectMenuProps {
    onLoaded: (preview: MenuPreview) => void
    initialValue?: string
    /** Pre-selects "From a collection" when the import was set up from a branches collection. */
    initialBranches?: BranchesSource | null
}

type InputMode = "links" | "collection"

export function SelectMenu({ onLoaded, initialValue = "", initialBranches = null }: SelectMenuProps) {
    const [mode, setMode] = useState<InputMode>(initialBranches ? "collection" : "links")
    const [customerInput, setCustomerInput] = useState(initialValue)
    const [isLoading, setIsLoading] = useState(false)

    // "From a collection": the user's own collections + the chosen collection/fields.
    const [collections, setCollections] = useState<BranchCollectionOption[] | null>(null)
    const [branches, setBranches] = useState<BranchesSource | null>(initialBranches)

    // Ignore an in-flight load if the plugin/UI unmounts (abort the fetch + skip any setState).
    const abortRef = useRef<AbortController | null>(null)
    const mountedRef = useRef(true)
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            abortRef.current?.abort()
        }
    }, [])

    useEffect(() => {
        if (mode !== "collection" || collections) return
        listBranchCollections()
            .then(options => {
                if (!mountedRef.current) return
                setCollections(options)
                // Keep a saved choice if its collection still exists; otherwise preselect the first.
                setBranches(current =>
                    current && options.some(option => option.id === current.collectionId)
                        ? current
                        : options[0]
                          ? branchesFor(options[0])
                          : null
                )
            })
            .catch((error: unknown) => {
                console.error(error)
                framer.notify("Couldn’t read this project’s collections.", { variant: "error" })
            })
    }, [mode, collections])

    const selected = collections?.find(option => option.id === branches?.collectionId) ?? null
    const linkCount = splitMenuInput(customerInput).length

    const canSubmit =
        !isLoading && (mode === "links" ? linkCount > 0 : Boolean(branches?.collectionId && branches.urlFieldId))

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const input: MenuInput | null =
            mode === "links"
                ? { kind: "links", links: splitMenuInput(customerInput) }
                : branches
                  ? { kind: "collection", branches }
                  : null
        if (!input) return

        try {
            setIsLoading(true)
            const preview = await loadMenuPreview(input, controller.signal)
            if (!mountedRef.current || controller.signal.aborted) return
            onLoaded(preview)
        } catch (error) {
            if (controller.signal.aborted || !mountedRef.current) return // unmounted/superseded — ignore
            console.error(error)
            framer.notify(error instanceof Error ? error.message : "Failed to load the menu.", { variant: "error" })
            setIsLoading(false)
        }
    }

    return (
        <main className="framer-hide-scrollbar setup">
            <div className="intro">
                <div className="logo">
                    <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none">
                        <title>Restaurant Menu Import</title>
                        <path
                            fill="currentColor"
                            d="M15.5 8c3.59 0 6.5 1.38 6.5 3.083 0 1.702-2.91 3.082-6.5 3.082S9 12.785 9 11.083C9 9.38 11.91 8 15.5 8Zm6.5 7.398c0 1.703-2.91 3.083-6.5 3.083S9 17.101 9 15.398v-2.466c0 1.703 2.91 3.083 6.5 3.083s6.5-1.38 6.5-3.083Zm0 4.316c0 1.703-2.91 3.083-6.5 3.083S9 21.417 9 19.714v-2.466c0 1.702 2.91 3.083 6.5 3.083S22 18.95 22 17.248Z"
                        />
                    </svg>
                </div>
                <div className="content">
                    <h2>Restaurant Menu Import</h2>
                    <p>Add menu links — each becomes a location — then choose what to import.</p>
                </div>
            </div>

            <div className="providers">
                <span className="providers-label">Supported menu providers</span>
                {PROVIDERS.map(provider => (
                    <div key={provider.platform} className="provider">
                        <span className="provider-name">{provider.name}</span>
                        <code>{provider.host}</code>
                    </div>
                ))}
            </div>

            <div className="segmented" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "links"}
                    className={mode === "links" ? "active" : ""}
                    onClick={() => setMode("links")}
                    disabled={isLoading}
                >
                    Paste links
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "collection"}
                    className={mode === "collection" ? "active" : ""}
                    onClick={() => setMode("collection")}
                    disabled={isLoading}
                >
                    From a collection
                </button>
            </div>

            <form onSubmit={handleSubmit}>
                {mode === "links" ? (
                    <label htmlFor="customer" className="links">
                        <textarea
                            id="customer"
                            rows={5}
                            placeholder={"Paste menu links, one per line"}
                            value={customerInput}
                            onChange={event => setCustomerInput(event.target.value)}
                            autoComplete="off"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={isLoading}
                        />
                    </label>
                ) : collections === null ? (
                    <div className="field-hint">Loading collections…</div>
                ) : collections.length === 0 ? (
                    <div className="field-hint">
                        No collections yet. Create one in the CMS with a branch name and a menu link field.
                    </div>
                ) : (
                    <>
                        <label>
                            <span>Collection</span>
                            <select
                                value={branches?.collectionId ?? ""}
                                onChange={event => {
                                    const option = collections.find(c => c.id === event.target.value)
                                    setBranches(option ? branchesFor(option) : null)
                                }}
                                disabled={isLoading}
                            >
                                {collections.map(option => (
                                    <option key={option.id} value={option.id}>
                                        {option.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span>Menu link</span>
                            <select
                                value={branches?.urlFieldId ?? ""}
                                onChange={event =>
                                    setBranches(current => current && { ...current, urlFieldId: event.target.value })
                                }
                                disabled={isLoading || !selected?.linkFields.length}
                            >
                                {!selected?.linkFields.length && <option value="">No link or text fields</option>}
                                {selected?.linkFields.map(field => (
                                    <option key={field.id} value={field.id}>
                                        {field.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span>Branch name</span>
                            <select
                                value={branches?.nameFieldId ?? ""}
                                onChange={event =>
                                    setBranches(
                                        current => current && { ...current, nameFieldId: event.target.value || null }
                                    )
                                }
                                disabled={isLoading}
                            >
                                <option value="">Slug</option>
                                {selected?.nameFields.map(field => (
                                    <option key={field.id} value={field.id}>
                                        {field.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                )}
                <button type="submit" disabled={!canSubmit}>
                    {isLoading ? (
                        <div className="framer-spinner" />
                    ) : mode === "links" && linkCount > 1 ? (
                        `Load ${linkCount} menus`
                    ) : mode === "collection" && selected ? (
                        `Load from ${selected.name}`
                    ) : (
                        "Next"
                    )}
                </button>
            </form>
        </main>
    )
}

/** Default field choice for a collection: a field named like "menu"/"link"/"url", and "name"/"title". */
function branchesFor(option: BranchCollectionOption): BranchesSource {
    return {
        collectionId: option.id,
        urlFieldId: guessField(option.linkFields, /menu|link|url/i)?.id ?? "",
        nameFieldId: guessField(option.nameFields, /name|title|branch/i)?.id ?? null,
    }
}

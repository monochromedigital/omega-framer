import { framer, type ManagedCollection, useIsAllowedTo } from "@framer/plugin"
import { useState } from "react"
import { importMenu, importMethods, parseCustomerId } from "./data"

interface ImportMenuProps {
    collection: ManagedCollection
}

export function ImportMenu({ collection }: ImportMenuProps) {
    const [customerInput, setCustomerInput] = useState("")
    const [isImporting, setIsImporting] = useState(false)
    const isAllowed = useIsAllowedTo(...importMethods)

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        try {
            setIsImporting(true)
            const customerId = parseCustomerId(customerInput)
            await importMenu(collection, customerId)
            framer.closePlugin("Menu imported successfully", { variant: "success" })
        } catch (error) {
            console.error(error)
            framer.notify(error instanceof Error ? error.message : "Failed to import the menu.", {
                variant: "error",
            })
            setIsImporting(false)
        }
    }

    return (
        <main className="framer-hide-scrollbar setup">
            <div className="intro">
                <div className="logo">
                    <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none">
                        <title>Omega Menu</title>
                        <path
                            fill="currentColor"
                            d="M15.5 8c3.59 0 6.5 1.38 6.5 3.083 0 1.702-2.91 3.082-6.5 3.082S9 12.785 9 11.083C9 9.38 11.91 8 15.5 8Zm6.5 7.398c0 1.703-2.91 3.083-6.5 3.083S9 17.101 9 15.398v-2.466c0 1.703 2.91 3.083 6.5 3.083s6.5-1.38 6.5-3.083Zm0 4.316c0 1.703-2.91 3.083-6.5 3.083S9 21.417 9 19.714v-2.466c0 1.702 2.91 3.083 6.5 3.083S22 18.95 22 17.248Z"
                        />
                    </svg>
                </div>
                <div className="content">
                    <h2>Omega Menu Import</h2>
                    <p>
                        Paste an Omega menu URL (or customer id). This collection becomes <strong>Menu Items</strong>;
                        linked <strong>Menu Categories</strong> and <strong>Menu Sections</strong> collections are created
                        automatically for nested lists.
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit}>
                <label htmlFor="customer">
                    <input
                        id="customer"
                        type="text"
                        placeholder="tavolina or menu URL"
                        value={customerInput}
                        onChange={event => setCustomerInput(event.target.value)}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={isImporting || !isAllowed}
                    />
                </label>
                <button
                    type="submit"
                    disabled={!customerInput.trim() || isImporting || !isAllowed}
                    title={isAllowed ? undefined : "Insufficient permissions"}
                >
                    {isImporting ? <div className="framer-spinner" /> : "Import Menu"}
                </button>
            </form>
        </main>
    )
}

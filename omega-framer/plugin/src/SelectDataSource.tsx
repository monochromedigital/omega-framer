import { framer } from "@framer/plugin"
import { useState } from "react"
import { type DataSource, type DataSourceId, dataSourceOptions, getDataSource, parseCustomerId } from "./data"

interface SelectDataSourceProps {
    onSelectDataSource: (dataSource: DataSource) => void
}

export function SelectDataSource({ onSelectDataSource }: SelectDataSourceProps) {
    const [customerInput, setCustomerInput] = useState("")
    const [selectedDataSourceId, setSelectedDataSourceId] = useState<DataSourceId>(dataSourceOptions[0].id)
    const [isLoading, setIsLoading] = useState(false)

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        try {
            setIsLoading(true)
            const customerId = parseCustomerId(customerInput)
            const dataSource = await getDataSource(selectedDataSourceId, customerId)
            onSelectDataSource(dataSource)
        } catch (error) {
            console.error(error)
            framer.notify(error instanceof Error ? error.message : "Failed to load the menu.", {
                variant: "error",
            })
        } finally {
            setIsLoading(false)
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
                    <p>Paste an Omega menu URL (or customer id) and choose what to import.</p>
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
                    />
                </label>
                <label htmlFor="collection">
                    <select
                        id="collection"
                        onChange={event => setSelectedDataSourceId(event.target.value as DataSourceId)}
                        value={selectedDataSourceId}
                    >
                        {dataSourceOptions.map(({ id, name }) => (
                            <option key={id} value={id}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="submit" disabled={!customerInput.trim() || isLoading}>
                    {isLoading ? <div className="framer-spinner" /> : "Next"}
                </button>
            </form>
        </main>
    )
}

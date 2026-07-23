import "./App.css"

import { framer, type ManagedCollection } from "@framer/plugin"
import { useEffect, useLayoutEffect, useState } from "react"
import { type DataSource, type DataSourceId, getDataSource } from "./data"
import { FieldMapping } from "./FieldMapping"
import { SelectDataSource } from "./SelectDataSource"

interface AppProps {
    collection: ManagedCollection
    previousDataSourceId: string | null
    previousCustomerId: string | null
}

export function App({ collection, previousDataSourceId, previousCustomerId }: AppProps) {
    const canRestore = Boolean(previousDataSourceId && previousCustomerId)
    const [dataSource, setDataSource] = useState<DataSource | null>(null)
    const [isLoadingDataSource, setIsLoadingDataSource] = useState(canRestore)

    useLayoutEffect(() => {
        const hasDataSourceSelected = Boolean(dataSource)

        framer.showUI({
            width: hasDataSourceSelected ? 360 : 280,
            height: hasDataSourceSelected ? 425 : 340,
            minWidth: hasDataSourceSelected ? 360 : undefined,
            minHeight: hasDataSourceSelected ? 425 : undefined,
            resizable: hasDataSourceSelected,
        })
    }, [dataSource])

    useEffect(() => {
        if (!previousDataSourceId || !previousCustomerId) {
            return
        }

        const abortController = new AbortController()

        setIsLoadingDataSource(true)
        getDataSource(previousDataSourceId as DataSourceId, previousCustomerId, abortController.signal)
            .then(setDataSource)
            .catch(error => {
                if (abortController.signal.aborted) return

                console.error(error)
                framer.notify(
                    `Error loading previously configured menu “${previousCustomerId}”. Check the logs for more details.`,
                    {
                        variant: "error",
                    }
                )
            })
            .finally(() => {
                if (abortController.signal.aborted) return

                setIsLoadingDataSource(false)
            })

        return () => abortController.abort()
    }, [previousDataSourceId, previousCustomerId])

    if (isLoadingDataSource) {
        return (
            <main className="loading">
                <div className="framer-spinner" />
            </main>
        )
    }

    if (!dataSource) {
        return <SelectDataSource onSelectDataSource={setDataSource} />
    }

    return <FieldMapping collection={collection} dataSource={dataSource} />
}

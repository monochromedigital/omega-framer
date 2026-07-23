import "@framer/plugin/framer.css"

import { framer } from "@framer/plugin"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { PLUGIN_KEYS, syncExistingCollection } from "./data"

const activeCollection = await framer.getActiveManagedCollection()

const previousDataSourceId = await activeCollection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)
const previousCustomerId = await activeCollection.getPluginData(PLUGIN_KEYS.CUSTOMER_ID)

const { didSync } = await syncExistingCollection(activeCollection, previousDataSourceId, previousCustomerId)

if (didSync) {
    framer.closePlugin("Synchronization successful", {
        variant: "success",
    })
} else {
    const root = document.getElementById("root")
    if (!root) throw new Error("Root element not found")

    createRoot(root).render(
        <StrictMode>
            <App
                collection={activeCollection}
                previousDataSourceId={previousDataSourceId}
                previousCustomerId={previousCustomerId}
            />
        </StrictMode>
    )
}

import "@framer/plugin/framer.css"

import { framer } from "@framer/plugin"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { parseImportConfig, PLUGIN_KEYS, syncExistingCollection } from "./data"

const activeCollection = await framer.getActiveManagedCollection()

const previousDataSourceId = await activeCollection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)
const previousCustomerId = await activeCollection.getPluginData(PLUGIN_KEYS.CUSTOMER_ID)
const previousImportConfig = await activeCollection.getPluginData(PLUGIN_KEYS.IMPORT_CONFIG)

// Resync button (syncManagedCollection mode) → sync in place and close.
// Opening via the plugin menu (configureManagedCollection mode) → show the UI so the Omega
// link and filters can be edited, pre-filled with the current settings.
const { didSync } = await syncExistingCollection(
    activeCollection,
    previousDataSourceId,
    previousCustomerId,
    previousImportConfig
)

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
                initialCustomerId={previousCustomerId}
                initialConfig={parseImportConfig(previousImportConfig)}
            />
        </StrictMode>
    )
}

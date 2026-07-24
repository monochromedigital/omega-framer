import "@framer/plugin/framer.css"

import { framer } from "@framer/plugin"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { parseImportConfig, PLUGIN_KEYS, syncExistingCollection } from "./data"
import { OpenFromCMS } from "./OpenFromCMS.tsx"

function render(node: React.ReactNode) {
    const root = document.getElementById("root")
    if (!root) throw new Error("Root element not found")
    createRoot(root).render(<StrictMode>{node}</StrictMode>)
}

// This plugin only works from the CMS, where Framer hands us a managed collection (canvas mode
// blocks the managed-collection APIs it needs). Resync (syncManagedCollection) syncs in place and
// closes; opening via the CMS (configureManagedCollection) shows the UI to edit the link/filters.
// Any other launch (e.g. the Plugins menu → canvas mode) shows a "use it from the CMS" message.
if (framer.mode === "syncManagedCollection" || framer.mode === "configureManagedCollection") {
    const activeCollection = await framer.getActiveManagedCollection()

    const previousDataSourceId = await activeCollection.getPluginData(PLUGIN_KEYS.DATA_SOURCE_ID)
    const previousMenuSource = await activeCollection.getPluginData(PLUGIN_KEYS.CUSTOMER_ID)
    const previousImportConfig = await activeCollection.getPluginData(PLUGIN_KEYS.IMPORT_CONFIG)

    const { didSync } = await syncExistingCollection(
        activeCollection,
        previousDataSourceId,
        previousMenuSource,
        previousImportConfig
    )

    if (didSync) {
        framer.closePlugin("Synchronization successful", { variant: "success" })
    } else {
        render(
            <App
                collection={activeCollection}
                initialSource={previousMenuSource}
                initialConfig={parseImportConfig(previousImportConfig)}
            />
        )
    }
} else {
    render(<OpenFromCMS />)
}

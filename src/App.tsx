import "./App.css"

import { framer, type ManagedCollection } from "@framer/plugin"
import { useLayoutEffect, useState } from "react"
import { ConfigureImport } from "./ConfigureImport"
import { DEFAULT_CONFIG, type ImportConfig, type MenuPreview } from "./data"
import { SelectMenu } from "./SelectMenu"

interface AppProps {
    collection: ManagedCollection
    /** Pre-fill when reconfiguring an already-synced collection (edit the Omega link/filters). */
    initialCustomerId?: string | null
    initialConfig?: ImportConfig
}

export function App({ collection, initialCustomerId, initialConfig = DEFAULT_CONFIG }: AppProps) {
    const [preview, setPreview] = useState<MenuPreview | null>(null)

    useLayoutEffect(() => {
        const configuring = Boolean(preview)
        framer.showUI({
            width: configuring ? 320 : 280,
            height: configuring ? 500 : 316,
            minWidth: configuring ? 320 : undefined,
            minHeight: configuring ? 400 : undefined,
            resizable: configuring,
        })
    }, [preview])

    if (!preview) {
        return <SelectMenu onLoaded={setPreview} initialValue={initialCustomerId ?? ""} />
    }

    return (
        <ConfigureImport
            collection={collection}
            preview={preview}
            initialConfig={initialConfig}
            onBack={() => setPreview(null)}
        />
    )
}

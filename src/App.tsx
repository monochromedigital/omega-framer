import "./App.css"

import { framer, type ManagedCollection } from "@framer/plugin"
import { useLayoutEffect, useState } from "react"
import { ConfigureImport } from "./ConfigureImport"
import type { MenuPreview, StoredSync } from "./data"
import { SelectMenu } from "./SelectMenu"

interface AppProps {
    collection: ManagedCollection
    /** The collection's saved sync state — pre-fills the links/filters when reconfiguring. */
    stored: StoredSync
}

export function App({ collection, stored }: AppProps) {
    const [preview, setPreview] = useState<MenuPreview | null>(null)

    useLayoutEffect(() => {
        const configuring = Boolean(preview)
        framer.showUI({
            width: configuring ? 340 : 300,
            // The setup screen lists the supported providers and a multi-line links box.
            height: configuring ? 560 : 500,
            minWidth: configuring ? 320 : undefined,
            minHeight: configuring ? 400 : undefined,
            resizable: configuring,
        })
    }, [preview])

    if (!preview) {
        return (
            <SelectMenu
                onLoaded={setPreview}
                initialValue={stored.branches ? "" : stored.sources.join("\n")}
                initialBranches={stored.branches}
            />
        )
    }

    return (
        <ConfigureImport
            collection={collection}
            stored={stored}
            preview={preview}
            initialConfig={stored.config}
            onBack={() => setPreview(null)}
        />
    )
}

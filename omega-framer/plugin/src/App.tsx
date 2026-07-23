import "./App.css"

import { framer, type ManagedCollection } from "@framer/plugin"
import { useLayoutEffect } from "react"
import { ImportMenu } from "./ImportMenu"

interface AppProps {
    collection: ManagedCollection
}

export function App({ collection }: AppProps) {
    useLayoutEffect(() => {
        framer.showUI({ width: 280, height: 316 })
    }, [])

    return <ImportMenu collection={collection} />
}

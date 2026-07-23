import { framer } from "@framer/plugin"
import { useLayoutEffect } from "react"

/** Shown when the plugin is opened outside the CMS (e.g. from the Plugins menu / canvas mode),
 *  where Framer blocks the managed-collection APIs this plugin needs. */
export function OpenFromCMS() {
    useLayoutEffect(() => {
        framer.showUI({ width: 280, height: 260 })
    }, [])

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
                    <h2>Open from the CMS</h2>
                    <p>
                        Omega Menu Import manages a CMS Collection. Open the <strong>CMS</strong>, add a new
                        Collection, and choose <strong>Omega Menu Import</strong> to manage it — then paste your
                        Omega menu link.
                    </p>
                </div>
            </div>
            <button type="button" onClick={() => framer.closePlugin()}>
                Got it
            </button>
        </main>
    )
}

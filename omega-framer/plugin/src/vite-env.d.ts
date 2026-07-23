/// <reference types="vite/client" />

interface ViteTypeOptions {
    strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
    /** Base URL of the deployed Omega worker proxy. Defaults to the Monochrome deployment. */
    readonly VITE_WORKER_BASE?: string
}

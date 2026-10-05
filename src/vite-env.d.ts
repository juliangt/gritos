/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Trystero appId (issue #90) — the peer-discovery namespace; see src/lib/p2p/appId.ts. */
  readonly VITE_TRYSTERO_APP_ID?: string
}

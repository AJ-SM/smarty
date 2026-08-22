/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIMULATE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

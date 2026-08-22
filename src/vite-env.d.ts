/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which backend to use: 'soluna' (the Worker, default) or 'none' (local
      only, no sync). Unset means 'soluna'. */
  readonly VITE_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** When this bundle was built, injected by vite.config.ts. Shown on the
    account screen so that "is this device running the build I just
    deployed?" is a question with an answer — a PWA that waits for consent
    before activating a new worker can otherwise sit several builds behind
    while every deploy looks fine from the outside. */
declare const __BUILT_AT__: string;

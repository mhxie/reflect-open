/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Build-target platform injected by the Tauri CLI (`darwin`, `windows`,
   * `linux`, `ios`, `android`). Absent in plain Vite builds and tests.
   */
  readonly TAURI_ENV_PLATFORM?: string
  /** Public Sentry project endpoint injected only into official release builds. */
  readonly VITE_SENTRY_DSN?: string
  /** `off` in local builds (`pnpm tauri:build:local`): no update checks or update UI. */
  readonly VITE_UPDATES?: string
}

/** App version injected from the canonical Tauri configuration by Vite. */
declare const __REFLECT_VERSION__: string

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
  /** `1` in a dev app launched to score search (`src/dev/search-eval-runner.tsx`). */
  readonly VITE_SEARCH_EVAL?: string
}

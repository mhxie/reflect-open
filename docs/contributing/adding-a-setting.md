# Adding a user setting

User settings are one JSON document in the OS config dir, next to the recents
store. It is never inside a graph's `.reflect/`: preferences follow the user
across graphs and must survive graph deletion.

- **Rust** (`apps/desktop/src-tauri/src/settings.rs`) persists the document as
  an *opaque* JSON object. **You will not touch Rust to add a setting.**
- **`@reflect/core`** owns the keys, defaults and validation
  (`packages/core/src/settings/schema.ts`) and the runtime document
  (`SettingsService`, `CoreServices.settings`).
- **The desktop app** reads settings with `useSettings()`
  (`apps/desktop/src/providers/settings-provider.tsx`) and renders controls in
  `apps/desktop/src/components/settings/`.

## 1. Declare the key in the schema

Add a field to `settingsObjectSchema` in `packages/core/src/settings/schema.ts`
(`settingsSchema` wraps it):

```ts
export const editorMarkdownSyntaxSchema = z.enum(['hide', 'show', 'hybrid']).catch('hide')

const settingsObjectSchema = z.looseObject({
  editorMarkdownSyntax: editorMarkdownSyntaxSchema,
  // yourNewSetting: yourNewSettingSchema,
})

export const settingsSchema = z.preprocess(upgradeLegacySettings, settingsObjectSchema)
```

- **Every value schema ends in `.catch(default)`.** A missing or invalid value
  degrades to its default instead of failing the load. So `DEFAULT_SETTINGS`
  picks up your default, and adding a key needs no migration: an old document lacks
  the key and parses to the default.
- **`z.looseObject` keeps unknown keys,** so a document from a newer version
  round-trips through an older one. This is why saves write the full merged
  document, never one key.
- **Migrations are named steps run by `upgradeLegacySettings`.** Each one
  leaves keys it doesn't own alone. Renaming a key is the usual one, because a
  new key would otherwise start at its default and silently drop the user's
  choice: seed it from the old key only when the new key is absent, and leave
  the old key in place. Every build (Reflect, Beta, Dev) shares the document,
  and an older one still reads its own; from the new build's first save the
  two keys are independent, so an older build keeps the value it had.
  `upgradeLegacyTranscriptionLanguage` is the example. A type change needs a
  new key name too, or an older build's `.catch` rewrites it to the default on
  its next save. `upgradeLegacyReadPart` in `ai/chat/store.ts` is the same
  `z.preprocess` hook for chat history, but it drops its old field; the shared
  settings document must not.
- **Name the key implementation-neutrally:** `editorMarkdownSyntax`, not
  `meowdownMarkMode`. Map to the library's vocabulary where it is consumed.

Export new value types from `packages/core/src/index.ts`. Cover the key in
`schema.test.ts`: default on missing, degrade on invalid, valid values pass.

## 2. Consume it

```tsx
const { settings, updateSettings, updateSettingsWith } = useSettings()
// read:  settings.yourNewSetting
// write scalar: updateSettings({ yourNewSetting: value })
// write derived/list value: updateSettingsWith((current) => ({ yourList: nextList(current) }))
```

Outside React, use the service (`settings.get()`, `update`, `updateWith`,
`subscribe`); a core service takes `settings` in its `deps`.

What `SettingsService` gives you (do not re-implement it):

- **Updates apply at once,** over defaults while the load is pending, and every
  subscriber sees them.
- **Use `updateSettingsWith` for read-modify-write** (lists, objects, derived
  values). Updaters sent before the load are replayed over the loaded document,
  so an early edit cannot compute from defaults and wipe the stored value.
- **Saves are async and ordered.** A failed save keeps the in-memory value,
  shows in the operations status UI, and retries on the next change or quit
  flush.
- **One runtime document.** `useSettings()` and `settings.get()` return the same
  object, which keeps its identity until something changes.
- **Paired side effects must await the load.** If a setting pairs with state
  elsewhere (e.g. an OS-keychain secret), call `whenSettingsLoaded()` before
  writing the other half: after a failed load, settings are session-only and
  the paired write would be stranded.
- **A failed load is session-only:** the service never writes over an
  unreadable or corrupt document.
- **No save button.** Settings apply live.

## 3. Add the control

`settings-screen.tsx` (⌘, or the palette's "Open settings") renders one
section component per group. A new group
needs an entry in `SETTINGS_SECTIONS` (`settings/sections.ts`), which drives the
navigator and section DOM ids, and its component rendered from
`SettingsScreen`.

Build sections from the shared primitives: `SettingsSection` (`section.tsx`),
`SettingsField` (`field.tsx`) and `SettingsOptionCard` (`option-card.tsx`). For
controls and overlays, use the shadcn primitives in
`apps/desktop/src/components/ui/` (`Switch`, `Select`, `Dialog`, …).

`onChange` calls `updateSettings` or `updateSettingsWith` directly (see
`appearance-section.tsx`, `editor-section.tsx`, `all-notes-section.tsx`). Test
at the narrowest useful level, always with `renderInApp` and never by mocking
providers (see [testing.md](testing.md)):

- For a round-tripping value, render the screen or section, use the control,
  and assert `core.settings.get()` or `core.settings.saves()`. Seed a stored
  value with `renderInApp(ui, { settings: { yourNewSetting } })`.
- For a section with its own branching, add a focused test next to it (e.g.
  `git-sync-section.test.tsx`, `rebuild-index-field.test.tsx`).

## Checklist

- [ ] Value schema with `.catch(default)` added to `settingsObjectSchema`
- [ ] New types exported from `packages/core/src/index.ts`
- [ ] Schema tests: missing → default, invalid → default, valid round-trips
- [ ] Control built from the shared primitives, wired to `updateSettings`
- [ ] New group registered in `settings/sections.ts` and rendered from
      `settings-screen.tsx`
- [ ] `renderInApp` test asserting `core.settings`
- [ ] No Rust changes, no per-key save logic, and migrations only as named
      steps in `upgradeLegacySettings`

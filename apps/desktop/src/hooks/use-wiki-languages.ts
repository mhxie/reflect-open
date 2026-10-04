import type { WikiLanguage } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * The wiki's languages, source first (the `wikiLanguages` setting). The
 * settings schema normalizes the list, so it is never empty.
 */
export function useWikiLanguages(): readonly WikiLanguage[] {
  return useSettings().settings.wikiLanguages
}

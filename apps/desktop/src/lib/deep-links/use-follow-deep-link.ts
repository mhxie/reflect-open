import { useCallback } from 'react'
import { useLinkNavigationHost } from '@/hooks/use-link-navigation-host.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/** Follow one in-app `reflect://` link. */
export type FollowDeepLink = (options: { href: string; openInNewWindow: boolean }) => void

/**
 * Follow an in-app deep link, applying the note-link modifier convention to
 * address-like links while leaving capture links as writes in this window.
 * A failed window open falls back only while the shared link intent
 * ({@link useLinkNavigationHost}) is still current.
 */
export function useFollowDeepLink(): FollowDeepLink {
  const { linkNavigation } = useAppServices()
  const host = useLinkNavigationHost()

  return useCallback(
    (options) => {
      linkNavigation.followDeepLink(options, host)
    },
    [host, linkNavigation],
  )
}

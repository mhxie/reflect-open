import type { ReactElement, ReactNode } from 'react'
import { useSidebarHoverReveal } from '@/hooks/use-sidebar-hover-reveal.ts'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome.ts'

interface SidebarHoverRevealProps {
  /** The workspace sidebar, mounted only while revealed. */
  children: ReactNode
}

/**
 * The hidden sidebar's way back for the pointer, after Arc: a thin strip on
 * the window's leading edge floats the sidebar over the content on hover, so
 * hiding it (`Mod-\`) buys the editor the full width without stranding the
 * navigation. Both layers share the title-bar strip's z-index and mount
 * before the note pane, so they cover the drag strip by tree order while the
 * ⌘K palette and other later overlays still cover them.
 */
export function SidebarHoverReveal({ children }: SidebarHoverRevealProps): ReactElement {
  const { revealed, overlayRef, edgeHandlers } = useSidebarHoverReveal()

  return (
    <>
      <div
        aria-hidden
        data-testid="sidebar-reveal-edge"
        className="fixed inset-y-0 left-0 z-40 w-1.5"
        {...edgeHandlers}
      />
      {revealed ? (
        <aside
          ref={overlayRef}
          id="workspace-sidebar"
          aria-label="Workspace"
          className="fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col overflow-hidden border-r border-border bg-surface-sunken shadow-pop motion-safe:animate-in motion-safe:duration-150 motion-safe:slide-in-from-left"
        >
          {/* The overlay covers the title-bar drag strip; restore dragging
              beneath the history arrows, which raise themselves above it. */}
          {hasMacosTitleBarOverlay ? (
            <div aria-hidden data-tauri-drag-region className="absolute inset-x-0 top-0 z-30 h-7" />
          ) : null}
          {children}
        </aside>
      ) : null}
    </>
  )
}

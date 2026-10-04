import {
  createContext,
  useCallback,
  use,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Open state for the "Jump to heading…" picker, shared by the command, the
 * dialog, and the shortcut guard.
 */
interface HeadingPickerContextValue {
  open: boolean
  openHeadingPicker: () => void
  closeHeadingPicker: () => void
}

const HeadingPickerContext = createContext<HeadingPickerContextValue | null>(null)

export function HeadingPickerProvider({ children }: { children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)

  const openHeadingPicker = useCallback(() => {
    setOpen(true)
  }, [])
  const closeHeadingPicker = useCallback(() => {
    setOpen(false)
  }, [])

  const value = useMemo<HeadingPickerContextValue>(
    () => ({ open, openHeadingPicker, closeHeadingPicker }),
    [open, openHeadingPicker, closeHeadingPicker],
  )
  return <HeadingPickerContext value={value}>{children}</HeadingPickerContext>
}

export function useHeadingPicker(): HeadingPickerContextValue {
  const context = use(HeadingPickerContext)
  if (!context) {
    throw new Error('useHeadingPicker must be used within a HeadingPickerProvider')
  }
  return context
}

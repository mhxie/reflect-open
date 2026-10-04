import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { OnDeviceAttestationCopy } from './on-device-attestation-copy.tsx'

interface OnDeviceAttestationDialogProps {
  /** The model id being attested. */
  model: string
  /** The endpoint being attested. */
  baseUrl: string
  /** The user confirmed: store the attestation. */
  onConfirm: () => void
  /** The user backed out: nothing changes. */
  onCancel: () => void
}

/**
 * The consent step for "Runs on this Mac": it names the exact endpoint and
 * model the attestation will cover. Rendered only while open.
 */
export function OnDeviceAttestationDialog({
  model,
  baseUrl,
  onConfirm,
  onCancel,
}: OnDeviceAttestationDialogProps): ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Treat this model as running on this Mac?</DialogTitle>
          <DialogDescription>
            <OnDeviceAttestationCopy model={model} baseUrl={baseUrl} />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            Turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

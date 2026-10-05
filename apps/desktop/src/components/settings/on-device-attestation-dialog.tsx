import { useState, type ReactElement } from 'react'
import type { OnDeviceServerKind } from '@reflect/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
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
  onConfirm: (server: OnDeviceServerKind) => void
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
  const [server, setServer] = useState<OnDeviceServerKind>(
    new URL(baseUrl).port === '11434' ? 'ollama' : 'openai-compatible',
  )
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
        <Select
          value={server}
          onValueChange={(value) => {
            if (value === 'ollama' || value === 'openai-compatible') setServer(value)
          }}
        >
          <SelectTrigger aria-label="Local inference server">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ollama">Ollama (check model provenance)</SelectItem>
            <SelectItem value="openai-compatible">Other local server (e.g. LM Studio)</SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onConfirm(server)}>
            Turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

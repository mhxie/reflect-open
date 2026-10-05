import { useState, type ReactElement } from 'react'
import { resolveOnDeviceTarget, type AiProvidersState } from '@reflect/core'
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
import { Switch } from '@/components/ui/switch.tsx'
import { backfillAssetDescriptionsVisibly } from '@/lib/asset-backfill.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'

/**
 * Settings → Search → OCR assets (Plan 20): a toggle for the automatic path
 * (read new images/PDFs as they're added) plus an explicit backfill, gated
 * behind a cost-warning confirmation because
 * an existing graph can hold many large or costly assets. Progress and final
 * state surface through the operations status UI.
 */
export function DescribeAssetsField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const { graph } = useGraph()
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)

  const hasProvider = settings.aiProviders.length > 0
  const localModels = settings.aiProviders.filter(
    (config) =>
      config.provider === 'openai-compatible' &&
      config.supportsImages &&
      resolveOnDeviceTarget(config) !== null,
  )
  const generation = graph?.generation ?? null

  const runBackfill = async (): Promise<void> => {
    setConfirming(false)
    if (generation === null || running) {
      return
    }
    const providers: AiProvidersState = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
    setRunning(true)
    try {
      await backfillAssetDescriptionsVisibly(
        generation,
        providers,
        settings.localOcrProviderId ?? null,
      )
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingsField
      legend="OCR assets"
      description={
        settings.localOcrProviderId
          ? 'Recognize images and PDFs on this Mac, including private and local-only notes. OCR text stays on this device.'
          : 'Make text in public images and PDFs searchable, or select a local vision model to include private notes.'
      }
    >
      <div className="mt-3">
        <Select
          value={settings.localOcrProviderId ?? 'default'}
          onValueChange={(value) =>
            updateSettings({ localOcrProviderId: value === 'default' ? null : value })
          }
        >
          <SelectTrigger aria-label="OCR model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default AI · public attachments only</SelectItem>
            {localModels.map((config) => (
              <SelectItem key={config.id} value={config.id}>
                {config.model} · on this Mac
              </SelectItem>
            ))}
            {settings.localOcrProviderId &&
            !localModels.some((config) => config.id === settings.localOcrProviderId) ? (
              <SelectItem value={settings.localOcrProviderId} disabled>
                Selected local model unavailable
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Switch
          aria-label="OCR new assets automatically"
          checked={settings.describeAssets}
          onCheckedChange={(checked) => updateSettings({ describeAssets: checked })}
        />
        <span className="text-xs text-text-muted">OCR new assets automatically</span>
      </div>
      <div className="mt-3 flex flex-col items-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={generation === null || !hasProvider || running}
          onClick={() => setConfirming(true)}
          className="text-text-secondary"
        >
          {running ? 'Backfilling…' : 'Backfill assets'}
        </Button>
        {!hasProvider ? (
          <p className="mt-2 text-xs text-text-muted">Add an AI provider to enable this.</p>
        ) : null}
      </div>
      {confirming ? (
        <Dialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setConfirming(false)
          }}
        >
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Backfill assets?</DialogTitle>
              <DialogDescription>
                {settings.localOcrProviderId
                  ? 'Images and PDFs, including those in private notes, will be read by your selected local vision model. OCR text stays on this Mac. PDF OCR is supported on macOS.'
                  : 'Images and PDFs in non-private notes will be sent to your AI provider so their text can appear in search.'}{' '}
                Assets that already have matching OCR are skipped.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void runBackfill()}>
                Backfill assets
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </SettingsField>
  )
}

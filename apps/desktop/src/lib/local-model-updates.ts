import { useSyncExternalStore } from 'react'
import {
  checkLocalModelUpdates,
  downloadLocalModel,
  errorMessage,
  localTranscriptionModel,
  skipLocalModelUpdate,
  subscribeLocalModelStatus,
  type LocalTranscriptionModelId,
} from '@reflect/core'
import { formatModelSize } from '@/lib/format-model-size.ts'
import { startOperation, type OperationHandle } from '@/lib/operations.ts'

/**
 * Upstream updates for the on-device transcription model. A downloaded model
 * never changes on its own: a newer revision is *offered* — as a toast with
 * an Update action, and in Settings beside Skip This Version — and dismissing
 * the toast means "later" (the next daily check offers it again). A newer
 * model generation is only announced, once: it needs an app update before
 * Reflect can use it.
 */

/** A newer revision of a downloaded model, awaiting the user's call. */
export interface PendingLocalModelUpdate {
  model: LocalTranscriptionModelId
  etag: string
  sizeBytes: number
}

let pending: PendingLocalModelUpdate | null = null
let offer: OperationHandle | null = null
const listeners = new Set<() => void>()

function setPending(next: PendingLocalModelUpdate | null): void {
  pending = next
  if (next === null) {
    offer?.dismiss()
    offer = null
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The update the last check found, until it is installed or skipped. */
export function usePendingLocalModelUpdate(): PendingLocalModelUpdate | null {
  return useSyncExternalStore(subscribe, () => pending)
}

/**
 * Ask upstream about `model` (throttled to once a day in Rust unless
 * `force`), and surface what it found. Network failures stay silent — the
 * next check retries.
 */
export async function checkForLocalModelUpdates(
  model: LocalTranscriptionModelId,
  force: boolean,
): Promise<void> {
  let report
  try {
    report = await checkLocalModelUpdates(model, force)
  } catch {
    return
  }
  for (const generation of report.generations) {
    startOperation(`Whisper ${generation} is available`, { persistent: true }).warn(
      'Reflect will offer it once an app update adds it.',
    )
  }
  if (report.revision === null) {
    return
  }
  setPending({ model, etag: report.revision.etag, sizeBytes: report.revision.sizeBytes })
  offer?.dismiss()
  offer = startOperation('Transcription model update', {
    persistent: true,
    description: `${localTranscriptionModel(model).label} · ${formatModelSize(report.revision.sizeBytes)}`,
    action: { label: 'Update', run: () => installLocalModelUpdate() },
  })
}

/** Download the pending revision, with its progress as an operation. */
export async function installLocalModelUpdate(): Promise<void> {
  const update = pending
  if (update === null) {
    return
  }
  setPending(null)
  const operation = startOperation('Updating the transcription model')
  const unlisten = await subscribeLocalModelStatus((model, status) => {
    if (model === update.model && status.status === 'downloading' && status.progress) {
      operation.progress(status.progress.downloaded, status.progress.total)
    }
  })
  try {
    await downloadLocalModel(update.model)
    operation.done()
  } catch (cause) {
    operation.fail(errorMessage(cause))
  } finally {
    unlisten()
  }
}

/** Never offer the pending revision again. */
export async function skipPendingLocalModelUpdate(): Promise<void> {
  const update = pending
  if (update === null) {
    return
  }
  setPending(null)
  await skipLocalModelUpdate(update.etag)
}

/** Drop the pending offer (the model was deleted or switched). */
export function clearPendingLocalModelUpdate(): void {
  setPending(null)
}

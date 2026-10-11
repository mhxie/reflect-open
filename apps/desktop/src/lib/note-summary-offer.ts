import { aiProvider, type AiProviderId, type NoteSummaryConsent } from '@reflect/core'
import { startOperation, type OperationHandle } from '@/lib/operations.ts'

/**
 * The one-time ask before cloud note summaries send anything: a persistent
 * operation naming how many public notes are waiting and the provider that
 * would receive them, with a Start action. The other answers (On this Mac,
 * Off) live in Settings → All Notes, which the offer points to; choosing one
 * withdraws it.
 */

/** How the ask reaches the app: the provider summaries would use now, and the go-ahead. */
export interface NoteSummaryOfferHandlers {
  /** The cloud provider the summary pass would use now, or `null` for none. */
  provider: () => AiProviderId | null
  /** Record the go-ahead. */
  start: () => void
}

let offer: OperationHandle | null = null

/**
 * Raise the ask, replacing an earlier one. Start agrees only to the provider
 * the ask names: if the default provider changed meanwhile, it asks again,
 * naming the new one.
 */
export function offerNoteSummaries(
  consent: NoteSummaryConsent,
  handlers: NoteSummaryOfferHandlers,
): void {
  offer?.dismiss()
  const notes = consent.notes === 1 ? '1 note' : `${consent.notes.toLocaleString()} notes`
  offer = startOperation(`Summarize ${notes} with ${aiProvider(consent.provider).label}?`, {
    persistent: true,
    description:
      'Private notes are never sent. To keep notes on this Mac or turn summaries off, open Settings → All Notes.',
    action: {
      label: 'Start',
      run: () => {
        const provider = handlers.provider()
        if (provider !== null && provider !== consent.provider) {
          offerNoteSummaries({ ...consent, provider }, handlers)
          return
        }
        withdrawNoteSummariesOffer()
        if (provider !== null) {
          handlers.start()
        }
      },
    },
  })
}

/** Take back a pending ask that no longer applies. */
export function withdrawNoteSummariesOffer(): void {
  offer?.dismiss()
  offer = null
}

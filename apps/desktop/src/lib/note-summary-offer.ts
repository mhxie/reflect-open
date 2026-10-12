import {
  aiProvider,
  sameSummariesModel,
  type AiSummariesModel,
  type NoteSummaryConsent,
} from '@reflect/core'
import { startOperation, type OperationHandle } from '@/lib/operations.ts'

/**
 * The one-time ask before cloud note summaries send anything: a persistent
 * operation naming how many public notes are waiting and the provider and
 * model that would receive them, with a Start action. The other answers (On
 * this Mac, another model, Off) live in Settings → All Notes, which the offer
 * points to; choosing one withdraws it.
 */

/** Where the cloud summary pass would send notes now. */
export type NoteSummaryDestination = Pick<NoteSummaryConsent, 'provider' | 'choice'>

/** How the ask reaches the app: where summaries would go now, and the go-ahead. */
export interface NoteSummaryOfferHandlers {
  /** The cloud provider and model the summary pass would use now, or `null` for none. */
  destination: () => NoteSummaryDestination | null
  /** Record the go-ahead for `choice`, pinning it. */
  start: (choice: AiSummariesModel) => void
}

let offer: OperationHandle | null = null

/**
 * Raise the ask, replacing an earlier one. Start agrees only to the provider
 * and model the ask names: if either changed meanwhile, it asks again, naming
 * the new ones.
 */
export function offerNoteSummaries(
  consent: NoteSummaryConsent,
  handlers: NoteSummaryOfferHandlers,
): void {
  offer?.dismiss()
  const notes = consent.notes === 1 ? '1 note' : `${consent.notes.toLocaleString()} notes`
  const destination = `${aiProvider(consent.provider).label} (${consent.choice.modelId})`
  offer = startOperation(`Summarize ${notes} with ${destination}?`, {
    persistent: true,
    description:
      'Private notes are never sent. To summarize on this Mac, pick another model, or turn summaries off, open Settings → All Notes.',
    action: {
      label: 'Start',
      run: () => {
        const current = handlers.destination()
        if (current !== null && !sameSummariesModel(current.choice, consent.choice)) {
          offerNoteSummaries({ ...consent, ...current }, handlers)
          return
        }
        withdrawNoteSummariesOffer()
        if (current !== null) {
          handlers.start(consent.choice)
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

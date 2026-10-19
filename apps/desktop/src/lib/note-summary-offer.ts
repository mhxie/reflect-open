import type { OperationsService } from '@reflect/app'
import {
  aiProvider,
  sameSummariesModel,
  type AiSummariesModel,
  type NoteSummaryConsent,
  type OperationHandle,
} from '@reflect/core'

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

/** The ask of one workspace: at most one is up at a time. */
export interface NoteSummaryOffer {
  /**
   * Raise the ask, replacing an earlier one. Start agrees only to the provider
   * and model the ask names: if either changed meanwhile, it asks again, naming
   * the new ones.
   */
  offer: (consent: NoteSummaryConsent, handlers: NoteSummaryOfferHandlers) => void
  /** Take back a pending ask that no longer applies. */
  withdraw: () => void
}

/**
 * The note-summary ask over `operations`, which shows it as a persistent
 * status line with a Start action.
 */
export function createNoteSummaryOffer(operations: OperationsService): NoteSummaryOffer {
  let current: OperationHandle | null = null

  const withdraw = (): void => {
    current?.dismiss()
    current = null
  }

  const offer = (consent: NoteSummaryConsent, handlers: NoteSummaryOfferHandlers): void => {
    current?.dismiss()
    const notes = consent.notes === 1 ? '1 note' : `${consent.notes.toLocaleString()} notes`
    const destination = `${aiProvider(consent.provider).label} (${consent.choice.modelId})`
    current = operations.start(`Summarize ${notes} with ${destination}?`, {
      persistent: true,
      description:
        'Private notes are never sent. To summarize on this Mac, pick another model, or turn summaries off, open Settings → All Notes.',
      action: {
        label: 'Start',
        run: () => {
          const now = handlers.destination()
          if (now !== null && !sameSummariesModel(now.choice, consent.choice)) {
            offer({ ...consent, ...now }, handlers)
            return
          }
          withdraw()
          if (now !== null) {
            handlers.start(consent.choice)
          }
        },
      },
    })
  }

  return { offer, withdraw }
}

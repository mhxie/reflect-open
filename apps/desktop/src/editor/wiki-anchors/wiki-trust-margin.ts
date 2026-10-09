/** Centre-to-centre distance of stacked margin marks: their 24px hit areas tile. */
const MARGIN_PITCH_PX = 24

/**
 * Space the margin marks in `dom`. Each sits beside the line its claim ends
 * on; a mark that would land within one pitch of the one above moves down
 * just enough, so marks never overlap or open the wrong card.
 */
export function spaceWikiTrustMarginMarks(dom: HTMLElement): void {
  const marks = [...dom.querySelectorAll<HTMLElement>('.wiki-trust-margin')]
  for (const mark of marks) mark.style.removeProperty('--wiki-trust-nudge')
  let floor = -Infinity
  for (const mark of marks) {
    // A mark under a hidden ancestor has no box and must not set the floor.
    if (mark.getClientRects().length === 0) continue
    const top = mark.getBoundingClientRect().top
    const nudge = Math.max(0, floor - top)
    if (nudge > 0) mark.style.setProperty('--wiki-trust-nudge', `${nudge}px`)
    floor = top + nudge + MARGIN_PITCH_PX
  }
}

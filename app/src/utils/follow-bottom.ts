/** How close to the end of the content still counts as being at the bottom, in pixels. */
export const BOTTOM_GAP_PX = 10

/**
 * Whether a chat view should keep its newest message in view when its content grows.
 *
 * `gap` is the distance from the bottom of the viewport to the end of the content. Being at the
 * bottom turns following on. Scrolling up (the position decreased) turns it off. Anything else
 * leaves it as it was: content that grows under a view that was following (a bubble that renders
 * its result after it arrived) moves the end away without the user having scrolled, and that must
 * not count as leaving the bottom.
 */
export function nextFollowBottom(
  following: boolean,
  previousPosition: number,
  position: number,
  gap: number,
): boolean {
  if (gap <= BOTTOM_GAP_PX) return true
  if (position < previousPosition - 2) return false
  return following
}

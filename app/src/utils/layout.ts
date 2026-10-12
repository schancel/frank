// Single source of truth for the drawer's mobile/desktop split (ticket #123). Quasar's own
// QDrawer treats `totalWidth <= breakpoint` as mobile (overlay), so "narrow" is inclusive of
// the breakpoint itself: exactly 800px is mobile, 801px is desktop.
export const DRAWER_BREAKPOINT = 800

export function isNarrowWidth(width: number): boolean {
  return width <= DRAWER_BREAKPOINT
}

// QPage's default min-height allows long content to grow QLayout and its drawer.
// Pages with their own scrolling region instead occupy the available viewport.
export function viewportPageStyle(offset: number, viewportHeight: number) {
  const height = `${Math.max(0, viewportHeight - offset)}px`
  return { height, minHeight: height }
}

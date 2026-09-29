// Single source of truth for the drawer's mobile/desktop split (ticket #123). Quasar's own
// QDrawer treats `totalWidth <= breakpoint` as mobile (overlay), so "narrow" is inclusive of
// the breakpoint itself: exactly 800px is mobile, 801px is desktop.
export const DRAWER_BREAKPOINT = 800

export function isNarrowWidth(width: number): boolean {
  return width <= DRAWER_BREAKPOINT
}

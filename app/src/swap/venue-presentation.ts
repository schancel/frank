/**
 * What the swap shell needs from a venue, whatever chain family it is on: an id, a label, an
 * optional honest note about who runs it, and the panel that does the swapping. Nothing here
 * knows about gas, allowances, lamports or programs: an EVM venue and a Solana venue each bring
 * their own panel, and each panel talks to its own family's venue interface
 * (`@frank/wallet/swap/evm-venue` for EVM).
 */
import type { Component } from 'vue'

export interface SwapVenuePresentation {
  /** Stable within the chain. */
  readonly id: string
  /** What the user sees as the venue's name. */
  readonly label: string
  /** A translatable note shown beside the name, e.g. who maintains the deployment. */
  readonly note?: { key: string; params?: Record<string, unknown> }
  readonly panel: Component
  /** Passed to the panel as its props. */
  readonly panelProps: Record<string, unknown>
}

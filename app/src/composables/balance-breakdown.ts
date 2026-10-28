/** The wallet owns balance observation and classification. Location rows partition its gross
 * known-owned total, including reservations and own transfers. `tooSmall` describes a subset
 * of received holdings already in that total; it is never added again. Payment availability
 * comes from the wallet's strict capability, never these presentation rows. */
export type BalanceBreakdownRowId =
  | 'main'
  | 'profile'
  | 'received'
  | 'other'
  | 'tooSmall'

export interface BalanceBreakdownRow {
  readonly id: BalanceBreakdownRowId
  readonly amount: bigint
  /** The account's address, for the rows that are one account. */
  readonly address?: string
  /** How many payments, for `received` and `tooSmall`. */
  readonly count?: number
}

export interface BalanceBreakdown {
  readonly rows: readonly BalanceBreakdownRow[]
  /** Sum of location rows; tooSmall is a subset of received, not an extra amount. */
  readonly total: bigint
}

/** What a wallet reports of where its balance is (`WalletBalanceParts`). */
export interface BreakdownParts {
  main: bigint
  profile: bigint
  received: bigint
  receivedCount: number
  sending: bigint
  tooSmall?: bigint
  tooSmallCount?: number
}

/** The parts of the wallet handle this reads. Every one is optional: a wallet of another
 * family simply has fewer rows. */
interface BreakdownWallet {
  identity?: { address?: { raw?: string } }
  getReceiveAddress?(): Promise<{ raw: string }>
  getBalanceParts?(): Promise<BreakdownParts>
}

/** The parts a wallet reports for its balance (`getBalanceParts`), as rows: they add up to the
 * balance read with them, including value currently reserved or settling. */
export function breakdownFromParts(
  parts: BreakdownParts,
  addresses: { main?: string; profile?: string },
): BalanceBreakdown {
  const rows: BalanceBreakdownRow[] = [
    { id: 'main', amount: parts.main, address: addresses.main },
  ]
  if (parts.profile > 0n)
    rows.push({
      id: 'profile',
      amount: parts.profile,
      address: addresses.profile,
    })
  if (parts.received > 0n)
    rows.push({
      id: 'received',
      amount: parts.received,
      count: parts.receivedCount,
    })
  if (parts.sending > 0n) rows.push({ id: 'other', amount: parts.sending })
  const total = rows.reduce((sum, row) => sum + row.amount, 0n)
  const tooSmall = parts.tooSmall ?? 0n
  if (tooSmall > 0n)
    rows.push({
      id: 'tooSmall',
      amount: tooSmall,
      count: parts.tooSmallCount ?? 0,
    })
  return { rows, total }
}

/** A family without the typed observation contract has no breakdown. Never estimate a gross
 * balance from an unrelated legacy-send quote or turn an unsupported read into a zero. */
export async function readBalanceBreakdown(
  walletHandle: unknown,
): Promise<BalanceBreakdown | undefined> {
  const wallet = (walletHandle ?? {}) as BreakdownWallet
  if (typeof wallet.getBalanceParts !== 'function') return undefined
  const parts = await wallet.getBalanceParts()
  const main =
    typeof wallet.getReceiveAddress === 'function'
      ? (await wallet.getReceiveAddress()).raw
      : undefined
  return breakdownFromParts(parts, {
    main,
    profile: wallet.identity?.address?.raw,
  })
}

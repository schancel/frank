/**
 * Where the active wallet's money is, for the balance breakdown on the Wallet page. A read of
 * what the wallet already answers; nothing here signs, moves or decides anything, and nothing
 * that decides whether a send is affordable reads it (that stays `useBalance().balance`).
 *
 * A row exists only when the wallet gives its number:
 * - `main`: the main account, which is the address the Wallet page shows for deposits;
 * - `profile`: the address on the user's profile, when it is a different address;
 * - `received`: payments and stamps received at one-time addresses that the chain shows funded;
 * - `other`: what the wallet holds in its remaining accounts (the accounts it prepares to pay
 *   for messages from, and change). The wallet reports one figure for everything outside the
 *   main account (`getContractCallFunds().otherBalance`); the profile address and the received
 *   payments, which have rows of their own, are taken out of it. A wallet that does not report
 *   that figure, or reports nothing beyond those two, has no such row.
 */
export type BalanceBreakdownRowId = 'main' | 'profile' | 'received' | 'other'

export interface BalanceBreakdownRow {
  readonly id: BalanceBreakdownRowId
  readonly amount: bigint
  /** The account's address, for the rows that are one account. */
  readonly address?: string
  /** How many payments, for `received`. */
  readonly count?: number
}

export interface BalanceBreakdown {
  readonly rows: readonly BalanceBreakdownRow[]
  /** The sum of the rows that make up the shown balance: every row but `other`. */
  readonly total: bigint
}

/** The parts of the wallet handle this reads. Every one is optional: a wallet of another
 * family simply has fewer rows. */
interface BreakdownWallet {
  identity?: { address?: { raw?: string } }
  getReceiveAddress?(): Promise<{ raw: string }>
  evmReader?: { getBalance?(address: string): Promise<bigint> }
  provider?: { getBalance?(address: string): Promise<bigint> }
  getBalanceParts?(): Promise<{
    main: bigint
    profile: bigint
    received: bigint
    receivedCount: number
    sending: bigint
  }>
  getReceivedPayments?(): readonly { spendable: boolean; amountWei: bigint }[]
  getContractCallFunds?(): Promise<{
    mainBalance: bigint
    otherBalance: bigint
  }>
}

export async function readBalanceBreakdown(
  walletHandle: unknown,
): Promise<BalanceBreakdown> {
  const wallet = (walletHandle ?? {}) as BreakdownWallet
  // The wallet's own account of its balance: the rows are its parts, so they add up to the
  // balance shown above them, and every row is money a send can draw on.
  if (typeof wallet.getBalanceParts === 'function') {
    const parts = await wallet.getBalanceParts()
    const mainAddress =
      typeof wallet.getReceiveAddress === 'function'
        ? (await wallet.getReceiveAddress()).raw
        : undefined
    const rows: BalanceBreakdownRow[] = [
      { id: 'main', amount: parts.main, address: mainAddress },
    ]
    if (parts.profile > 0n)
      rows.push({
        id: 'profile',
        amount: parts.profile,
        address: wallet.identity?.address?.raw,
      })
    if (parts.received > 0n)
      rows.push({
        id: 'received',
        amount: parts.received,
        count: parts.receivedCount,
      })
    if (parts.sending > 0n) rows.push({ id: 'other', amount: parts.sending })
    return { rows, total: rows.reduce((sum, row) => sum + row.amount, 0n) }
  }
  const balanceAt = (address: string): Promise<bigint> | undefined =>
    typeof wallet.evmReader?.getBalance === 'function'
      ? wallet.evmReader.getBalance(address)
      : typeof wallet.provider?.getBalance === 'function'
      ? wallet.provider.getBalance(address)
      : undefined

  const mainAddress =
    typeof wallet.getReceiveAddress === 'function'
      ? (await wallet.getReceiveAddress()).raw
      : undefined
  const profileAddress = wallet.identity?.address?.raw
  const profileIsSeparate =
    !!profileAddress &&
    !!mainAddress &&
    profileAddress.toLowerCase() !== mainAddress.toLowerCase()

  // The wallet's own account of the main account and of everything else. It can be unavailable
  // for a while (a transfer between the wallet's accounts is in flight): the rows that do not
  // need it are still shown.
  const funds =
    typeof wallet.getContractCallFunds === 'function'
      ? await wallet.getContractCallFunds().catch(() => undefined)
      : undefined
  const [main, profile] = await Promise.all([
    funds
      ? funds.mainBalance
      : mainAddress
      ? balanceAt(mainAddress)?.catch(() => undefined)
      : undefined,
    profileIsSeparate
      ? balanceAt(profileAddress)?.catch(() => undefined)
      : undefined,
  ])
  const payments = (wallet.getReceivedPayments?.() ?? []).filter(
    payment => payment.spendable && payment.amountWei > 0n,
  )
  const received = payments.reduce((sum, p) => sum + p.amountWei, 0n)

  const rows: BalanceBreakdownRow[] = []
  if (main !== undefined)
    rows.push({ id: 'main', amount: main, address: mainAddress })
  if (profile !== undefined && profile > 0n)
    rows.push({ id: 'profile', amount: profile, address: profileAddress })
  if (payments.length > 0)
    rows.push({ id: 'received', amount: received, count: payments.length })
  if (funds) {
    const other = funds.otherBalance - (profile ?? 0n) - received
    if (other > 0n) rows.push({ id: 'other', amount: other })
  }
  return {
    rows,
    total: rows
      .filter(row => row.id !== 'other')
      .reduce((sum, row) => sum + row.amount, 0n),
  }
}

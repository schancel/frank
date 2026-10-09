/**
 * Operator tool for blackjack payouts the bot cannot settle by itself (ticket #215).
 * STOP THE BOT FIRST (the LevelDB directory is single-process).
 *
 *   BLACKJACK_BOT_STATE_DIR=/path/to/state yarn tsx blackjack-payout-admin.livecheck.ts <verb>
 *
 * Verbs:
 *   list
 *       Every non-confirmed payout (status, amount, age, nonce, txHash).
 *   requeue <gameId> --i-verified-reverted
 *       ONLY for a `failed` payout (its tx mined and reverted, so no value moved). Moves it back to
 *       `owed`, dropping the journaled tx so it is signed afresh. Check the receipt on an
 *       explorer first; the flag is your statement that you did.
 *   requeue <gameId> --nonce-consumed-by <otherTxHash> --payer <payerAddress>
 *       For a signed `submitting`/`submitted` payout that can never mine because another tx from
 *       the same key used its nonce (this otherwise holds the payer lane forever). Needs RPC
 *       (MONAD_TESTNET_HTTP_RPC_URL, the bot's own configuration) and refuses, changing nothing,
 *       unless ALL of: the other tx is mined, was sent from the payer address with the payout's
 *       stored nonce; the old payout tx has no receipt and is not pending on the node; and the
 *       payer's confirmed transaction count is greater than that nonce. Any RPC error refuses.
 *       It is only as sound as the RPC: a lagging node could call the old tx unmined. CHECK AN
 *       EXPLORER FIRST -- requeueing a payout that later mines pays the winner twice.
 * `owed` payouts are retried by the bot forever and `confirmed` ones are done; both are refused.
 */
import { resolve } from 'path'

import { getAddress, JsonRpcProvider } from 'ethers'

import { BlackjackBotStateStore } from './blackjack-bot-state'

export interface PayoutListRow {
  gameId: string
  status: string
  amountWei: string
  playerAddress: string
  ageMs: number
  nonce: number | null
  txHash: string | null
}

export function listPayouts(state: BlackjackBotStateStore, now = Date.now()): PayoutListRow[] {
  return state.getUnconfirmedPayouts().map(([gameId, p]) => ({
    gameId,
    status: p.status,
    amountWei: p.amountWei.toString(),
    playerAddress: state.getGame(gameId)!.playerAddress,
    ageMs: now - p.owedAt,
    nonce: p.nonce ?? null,
    txHash: p.txHash ?? null,
  }))
}

/** The subset of an ethers Provider the evidence check needs (injected in tests). */
export interface EvidenceProvider {
  getTransaction(hash: string): Promise<{ from: string; nonce: number; blockNumber: number | null } | null>
  getTransactionReceipt(hash: string): Promise<{ status?: number | null } | null>
  getTransactionCount(address: string, blockTag: 'latest'): Promise<number>
}

export const DOUBLE_PAYMENT_REMINDER =
  'REMINDER: this evidence is only as sound as the RPC node (a lagging node can report the old tx as unmined). Check an explorer for the old payout tx before relying on it; requeueing a payout that later mines pays the winner twice.'

/** Plain requeue: only a `failed` (mined, reverted) payout. */
export async function requeuePayout(
  state: BlackjackBotStateStore,
  gameId: string,
  opts: { verifiedReverted: boolean },
): Promise<void> {
  if (!opts.verifiedReverted) {
    throw new Error('refusing to requeue: pass --i-verified-reverted after checking the reverted receipt on an explorer')
  }
  await state.requeuePayout(gameId, ['failed'])
  await state.flush()
}

/** Evidence-checked requeue of a signed `submitting`/`submitted` payout. Fails closed: every check
 * must pass and any RPC error refuses; nothing is changed unless all pass. */
export async function requeueNonceConsumed(
  state: BlackjackBotStateStore,
  gameId: string,
  opts: { otherTxHash: string; payerAddress: string; provider: EvidenceProvider },
): Promise<void> {
  const payout = state.getPayout(gameId)
  if (!payout) throw new Error('no payout is owed for this game')
  if (payout.status !== 'submitting' && payout.status !== 'submitted') {
    throw new Error(`nonce-consumed requeue only accepts submitting/submitted payouts (this one is ${payout.status})`)
  }
  if (payout.nonce === undefined || !payout.txHash) {
    throw new Error('the payout has no stored nonce/txHash to check against; refusing')
  }
  const { otherTxHash, payerAddress, provider } = opts
  const oldHash = payout.txHash
  if (otherTxHash.toLowerCase() === oldHash.toLowerCase()) {
    throw new Error('the other tx is the payout tx itself; refusing')
  }
  const payer = getAddress(payerAddress)
  try {
    const other = await provider.getTransaction(otherTxHash)
    const otherReceipt = await provider.getTransactionReceipt(otherTxHash)
    if (!other || !otherReceipt || other.blockNumber === null) {
      throw new Error(`the other tx ${otherTxHash} is not confirmed`)
    }
    if (getAddress(other.from) !== payer) {
      throw new Error(`the other tx was sent from ${other.from}, not the payer ${payer}`)
    }
    if (other.nonce !== payout.nonce) {
      throw new Error(`the other tx has nonce ${other.nonce}, the payout's nonce is ${payout.nonce}`)
    }
    const oldReceipt = await provider.getTransactionReceipt(oldHash)
    if (oldReceipt) throw new Error(`the old payout tx ${oldHash} HAS a receipt (it mined); not requeueing`)
    const oldTx = await provider.getTransaction(oldHash)
    if (oldTx) throw new Error(`the node still knows the old payout tx ${oldHash} (${oldTx.blockNumber === null ? 'pending in the mempool' : 'mined'}); not requeueing`)
    const count = await provider.getTransactionCount(payer, 'latest')
    if (!(count > payout.nonce)) {
      throw new Error(`the payer's confirmed transaction count ${count} is not greater than the payout nonce ${payout.nonce}`)
    }
  } catch (err) {
    throw new Error(`evidence check failed, nothing changed: ${(err as Error).message}`)
  }
  await state.requeuePayout(gameId, ['submitting', 'submitted'])
  await state.flush()
}

export async function runAdminCli(
  argv: string[],
  state: BlackjackBotStateStore,
  deps: { provider?: EvidenceProvider } = {},
): Promise<number> {
  const [command, gameId, ...flags] = argv
  const flagValue = (name: string) => {
    const i = flags.indexOf(name)
    return i >= 0 ? flags[i + 1] : undefined
  }
  if (command === 'list') {
    const rows = listPayouts(state)
    console.log(rows.length === 0 ? 'no unconfirmed payouts' : JSON.stringify(rows, null, 2))
    return 0
  }
  if (command === 'requeue' && gameId) {
    try {
      const otherTx = flagValue('--nonce-consumed-by')
      if (otherTx) {
        const payer = flagValue('--payer')
        if (!payer || !deps.provider) throw new Error('--nonce-consumed-by needs --payer <address> and an RPC provider')
        console.log(DOUBLE_PAYMENT_REMINDER)
        await requeueNonceConsumed(state, gameId, { otherTxHash: otherTx, payerAddress: payer, provider: deps.provider })
      } else {
        await requeuePayout(state, gameId, { verifiedReverted: flags.includes('--i-verified-reverted') })
      }
      console.log(`payout for game ${gameId} requeued as owed`)
      return 0
    } catch (err) {
      console.error(String((err as Error).message))
      return 1
    }
  }
  console.error('usage: list | requeue <gameId> --i-verified-reverted | requeue <gameId> --nonce-consumed-by <txHash> --payer <address>')
  return 2
}

if (require.main === module) {
  ;(async () => {
    const dir = resolve(process.cwd(), process.env.BLACKJACK_BOT_STATE_DIR ?? '/tmp/blackjack-bot-state')
    const state = new BlackjackBotStateStore(dir)
    await state.Open()
    const rpcUrl = process.env.MONAD_TESTNET_HTTP_RPC_URL
    const provider = rpcUrl ? (new JsonRpcProvider(rpcUrl) as unknown as EvidenceProvider) : undefined
    const code = await runAdminCli(process.argv.slice(2), state, { provider })
    await state.Close()
    process.exitCode = code
  })().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

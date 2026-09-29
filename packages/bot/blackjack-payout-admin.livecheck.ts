/**
 * Operator tool for blackjack payouts the bot cannot settle by itself (ticket #215).
 *
 *   cd packages/bot
 *   BLACKJACK_BOT_STATE_DIR=/path/to/state yarn tsx blackjack-payout-admin.livecheck.ts list
 *   BLACKJACK_BOT_STATE_DIR=/path/to/state yarn tsx blackjack-payout-admin.livecheck.ts \
 *     requeue <gameId> --i-verified-not-mined
 *
 * STOP THE BOT FIRST (the LevelDB directory is single-process).
 *
 * `requeue` moves a `failed` or `stuck` payout back to `owed` and DROPS its journaled transaction,
 * so the bot signs a fresh one. That is only safe if the old transaction did not and can never
 * mine (check the payer's confirmed nonce and the tx hash on an explorer, not just one RPC node);
 * hence the mandatory flag. Any other status is refused: a `submitting`/`submitted` payout may
 * still mine and is settled only by its receipt. There is deliberately no automatic re-sign rule.
 */
import { resolve } from 'path'

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

export async function requeuePayout(
  state: BlackjackBotStateStore,
  gameId: string,
  opts: { verifiedNotMined: boolean },
): Promise<void> {
  if (!opts.verifiedNotMined) {
    throw new Error('refusing to requeue: pass --i-verified-not-mined after checking on chain that the old tx did not and cannot mine')
  }
  await state.requeuePayout(gameId)
  await state.flush()
}

export async function runAdminCli(argv: string[], state: BlackjackBotStateStore): Promise<number> {
  const [command, gameId, ...flags] = argv
  if (command === 'list') {
    const rows = listPayouts(state)
    console.log(rows.length === 0 ? 'no unconfirmed payouts' : JSON.stringify(rows, null, 2))
    return 0
  }
  if (command === 'requeue' && gameId) {
    try {
      await requeuePayout(state, gameId, { verifiedNotMined: flags.includes('--i-verified-not-mined') })
      console.log(`payout for game ${gameId} requeued as owed`)
      return 0
    } catch (err) {
      console.error(String((err as Error).message))
      return 1
    }
  }
  console.error('usage: list | requeue <gameId> --i-verified-not-mined')
  return 2
}

if (process.env.NODE_ENV !== 'test') {
  ;(async () => {
    const dir = resolve(process.cwd(), process.env.BLACKJACK_BOT_STATE_DIR ?? '/tmp/blackjack-bot-state')
    const state = new BlackjackBotStateStore(dir)
    await state.Open()
    const code = await runAdminCli(process.argv.slice(2), state)
    await state.Close()
    process.exitCode = code
  })().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

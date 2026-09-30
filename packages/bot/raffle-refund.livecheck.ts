/**
 * Operator CLI: list or refund raffle entrant money that was swept but not credited (#363).
 * STOP the raffle bot first (it holds the state database lock).
 *
 *   cd packages/bot
 *   export MONAD_TESTNET_HTTP_RPC_URL=... RAFFLE_BOT_IDENTITY_JSON=... RAFFLE_BOT_STATE_DIR=...
 *   yarn raffle:refund --list
 *   yarn raffle:refund <unclaimed id>      # pays the recorded swept amount back once
 *
 * Re-running after a crash or a pending confirmation re-broadcasts the same signed transaction.
 */
import { resolve } from 'path'

import { JsonRpcProvider } from 'ethers'

import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { MonadHttpClient } from '@frank/wallet/monad-http'

import { botStateDir } from './bot-state-dir'
import { loadOrCreateIdentity, requiredEnv } from './qwen-bot-common'
import { RaffleBotStateStore } from './raffle-bot-state'
import { refundUnclaimed } from './raffle-refund'

async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error('usage: raffle:refund --list | <unclaimed id>')
  const state = new RaffleBotStateStore(
    botStateDir('raffle', 'RAFFLE_BOT_STATE_DIR'),
  )
  await state.Open()
  try {
    if (arg === '--list') {
      for (const r of state.getUnclaimed()) {
        console.log(
          `${r.id}\t${
            r.refundedTxHash
              ? 'REFUNDED ' + r.refundedTxHash
              : r.refund
              ? 'REFUND-PENDING ' + r.refund.txHash
              : 'unrefunded'
          }\t${r.sweptWei} wei\t${r.entrant}\t${r.reason}`,
        )
      }
      return
    }
    const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
    const identity = loadOrCreateIdentity(
      resolve(process.cwd(), requiredEnv('RAFFLE_BOT_IDENTITY_JSON')),
      'raffle-bot',
    )
    const provider = new JsonRpcProvider(rpcUrl)
    const signer = new MonadAccountTxSigner({
      privateKey: identity.toPrivateKeyHex(),
      provider,
      httpClient: new MonadHttpClient({ rpcUrl }),
    })
    const outcome = await refundUnclaimed({
      state,
      id: arg,
      ports: {
        getBalanceWei: () => provider.getBalance(signer.address, 'latest'),
        signTransfer: async (to, value) => {
          const t = await signer.buildAndSignTransfer(to, value)
          return { rawTx: t.rawTx, txHash: t.txHash }
        },
        broadcast: async (raw, hash) => {
          await signer.submitRaw(raw, hash)
        },
        getStatus: h => signer.getStatus(h),
      },
    })
    console.log(JSON.stringify(outcome))
    if (outcome.status === 'refused') process.exitCode = 1
  } finally {
    await state.Close()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(
      'RAFFLE REFUND FAILED:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  })
}

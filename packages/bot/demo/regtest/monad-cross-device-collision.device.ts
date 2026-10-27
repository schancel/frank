/**
 * One device of an account, in a process of its own, for monad-cross-device-collision.livecheck.ts.
 * A process opens an account's wallet once (the wallet refuses a second handle of the same
 * account), so the check's other device of the same account runs here and is driven over IPC.
 *
 *   argv: <relay URL> <stack state directory> <wallet label>
 *   messages in:  { id, op: 'receive', digest } | { id, op: 'send', to, text, stampWei }
 *                 | { id, op: 'keys' } | { id, op: 'close' }
 *   messages out: { ready: { address, mainAccount } } | { id, ok: true, result } | { id, ok: false, error }
 */
import { evmWalletInternals } from '@frank/wallet/evm-wallet'
import type { RegtestStack } from './regtest-stack'
import { openMonadWallet } from './monad-wallets'

type Request =
  | { id: number; op: 'receive'; digest: string }
  | { id: number; op: 'send'; to: string; text: string; stampWei: bigint }
  | { id: number; op: 'keys' }
  | { id: number; op: 'close' }

async function main() {
  const [relayUrl, stateDir, label] = process.argv.slice(2)
  const stack = {
    relayUrl,
    relayUrls: [relayUrl],
    // `openMonadWallet` only checks that the stack has the network.
    chains: { 'monad-regtest': {} },
    stateDir,
    relayLogPath: '',
    stop: async () => {},
  } as unknown as RegtestStack
  const device = await openMonadWallet(stack, label)
  const reply = (message: unknown) => process.send!(message)
  process.on('message', async (request: Request) => {
    try {
      let result: unknown
      if (request.op === 'receive') {
        await device.receive(message => message.payloadDigest === request.digest)
      } else if (request.op === 'send') {
        const send = () => device.chain.directMessages.send({
          wallet: device.handle,
          recipient: { raw: request.to },
          items: [{ type: 'text', text: request.text }],
          sealedSender: true,
          stampValue: request.stampWei,
        })
        let sent: Awaited<ReturnType<typeof send>>
        for (let tries = 0; ; tries++) {
          try {
            sent = await send()
            break
          } catch (error) {
            // This device's earlier send's own later transfers go to the node from the wallet's
            // background pass (the app runs it on a timer); until they land, its money is tied up.
            if (tries >= 100 || (error as Error).name !== 'InsufficientStampFundsError') throw error
            await device.chain.directMessages.reconcileAttempts({ wallet: device.handle, payloadDigests: [] }).catch(() => undefined)
            await device.handle.reobserveNativeOperations?.().catch(() => undefined)
            // A coin this device received is counted once a read of the chain shows it (the
            // app's balance read does this on its own timer).
            await device.handle.refreshReceivedPayments?.().catch(() => undefined)
            await new Promise(resolve => setTimeout(resolve, 3000))
          }
        }
        result = { digest: sent.payloadDigest, txHashes: sent.stampPayments.map(payment => payment.txHash) }
      } else if (request.op === 'keys') {
        result = (evmWalletInternals(device.handle).coinList?.all() ?? [])
          .filter(coin => coin.privateKey)
          .map(coin => [coin.account.toLowerCase(), coin.privateKey])
      } else {
        await device.close()
        reply({ id: request.id, ok: true })
        process.exit(0)
      }
      reply({ id: request.id, ok: true, result })
    } catch (error) {
      reply({ id: request.id, ok: false, error: `${(error as Error).name}: ${(error as Error).message}` })
    }
  })
  reply({ ready: { address: device.address, mainAccount: device.mainAccount } })
}

void main().catch(error => {
  console.error(error)
  process.exit(1)
})

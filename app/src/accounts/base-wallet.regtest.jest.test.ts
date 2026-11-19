/** @jest-environment node */

/**
 * INTEGRATION: the app opens the account's main balance, Lotus v2, through the REAL relay binary
 * on a real `lotusd -regtest` with Chronik (packages/bot/demo/regtest, `lotus-v2-regtest`).
 *
 * The path is the app's own: the host's base-chain composition (`resolveMainWalletChain`), the
 * wallet row it makes main, `openUtxoWallet` (the relay's advertised operator checkpoint, then
 * `openRelayUtxoChain`), and the Wallet page's History read (`loadNativeTransfers`). Only session
 * custody is replaced: it hands the relay chain a fixed test root, as the real session hands it
 * the account's Bitcoin-family domain root.
 *
 *   FRANK_REQUIRE_NODES=1 LOTUSD_BIN=<lotus>/daemon/.build/v2-current/lotusd \
 *     CASHWEBD_BIN=<cashwebd-exe> yarn --cwd app jest src/accounts/base-wallet.regtest.jest.test.ts
 *
 * Without LOTUSD_BIN the suite reports NOT RUN (fails under FRANK_REQUIRE_NODES=1). Lotus v2
 * publishes no release, so no hosted CI job runs it (packages/wallet/ci-anvil-suites.jest.test.ts).
 */
import { existsSync } from 'fs'

import { nodeSuiteReady } from '@frank/wallet/node-binaries.testutil'
import type { RelayUtxoChain } from '@frank/wallet/chain'
import type { LotusRegtest } from '../../../packages/bot/demo/regtest/lotus-regtest'
import type { RegtestStack } from '../../../packages/bot/demo/regtest/regtest-stack'

const lotusd = process.env.LOTUSD_BIN
const suite = nodeSuiteReady('app base-wallet.regtest', [
  {
    name: 'a Lotus v2 lotusd with Chronik',
    found: lotusd !== undefined && existsSync(lotusd),
    hint: 'set LOTUSD_BIN to a lotusd built from the Lotus repository v2 series',
  },
])
  ? describe
  : describe.skip

const XPI = 1_000_000n
let mockRelayUrl = ''
const mockState = {
  status: 'ready',
  account: { receipt: { context: { accountId: 'account-a' } } },
  revision: 1,
}
jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    // Custody's part, in place: the relay chain builds the wallet from the account's root.
    createUtxoWallet: (relay: RelayUtxoChain) =>
      relay.createWallet(new Uint8Array(32).fill(41)),
  },
}))
jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  loadMonadChainConfigFromEnv: () => ({ relayBaseUrl: mockRelayUrl }),
}))

suite('the app opens its Lotus v2 main balance through the real relay', () => {
  jest.setTimeout(300_000)
  let stack: RegtestStack
  const storage = new Map<string, string>()

  beforeAll(async () => {
    // The wallet's browser store (localStorage), as the app has it.
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    }
    const { startRegtestStack } = await import(
      '../../../packages/bot/demo/regtest/regtest-stack'
    )
    stack = await startRegtestStack({ chains: ['lotus-v2-regtest'] })
    mockRelayUrl = stack.relayUrl
  }, 300_000)
  afterAll(async () => {
    await stack?.stop()
  }, 120_000)

  it('composes, opens, receives, sends and lists History', async () => {
    const { resolveMainWalletChain } = await import('./base-wallet')
    const { buildWalletConfigs } = await import('../utils/wallet-configs')
    const { openUtxoWallet } = await import('./utxo-wallets')
    const { loadNativeTransfers } = await import(
      '../components/wallet/wallet-history'
    )

    const main = resolveMainWalletChain('lotus-v2-regtest', {
      chainIdentifier: 'monad-regtest',
      isTestnet: true,
    })!
    const mainRow = buildWalletConfigs(main).find(row => row.isMain)!
    expect(mainRow.id).toBe('lotus-v2-regtest')

    const { wallet, chain } = await openUtxoWallet(mainRow.id)
    expect(chain).toMatchObject({
      chainIdentifier: 'lotus-v2-regtest',
      unit: 'rXPI',
    })
    expect(await openUtxoWallet(mainRow.id)).toMatchObject({ wallet })

    const lotus = stack.chains['lotus-v2-regtest'] as LotusRegtest
    const receive = await wallet.getReceiveAddress()
    expect(receive.raw).toMatch(/^rxpi1p/)
    const funded = await lotus.fund(receive.raw, 25n * XPI)
    expect(await wallet.getBalance()).toBe(25n * XPI)
    expect(chain.toDisplayAmount(await wallet.getBalance())).toBe('25')

    // A send to another address of the chain: pending in History until a block includes it.
    const payee =
      'rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u'
    const sent = await wallet.sendNative!({
      recipient: { raw: payee },
      value: 4n * XPI,
    })
    const pending = await loadNativeTransfers(wallet, 'lotus-v2-regtest')
    expect(pending.status).toBe('available')
    expect(pending.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'received',
          txid: funded,
          value: 25n * XPI,
        }),
        expect.objectContaining({
          direction: 'sent',
          txid: sent.txHash,
          value: 4n * XPI,
          recipient: payee,
          state: 'pending',
        }),
      ]),
    )
    await lotus.mine(1)
    await wallet.getBalance()
    const confirmed = await loadNativeTransfers(wallet, 'lotus-v2-regtest')
    const row = confirmed.rows.find(r => r.direction === 'sent')!
    expect(row.state).toBe('confirmed')
    expect(await wallet.getBalance()).toBe(25n * XPI - 4n * XPI - row.fee!)
  })
})

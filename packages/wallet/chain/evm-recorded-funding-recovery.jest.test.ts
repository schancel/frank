/** Real typed wallets, crypto and LevelDB; relay/node effects use the established scripted boundary. */
import {
  fixture,
  providerRequests,
  chainHttpRequests,
  mockBalances,
  offlineChain,
  useProviderStandIns,
} from './canonical-two-wallets.testutil'
import { SigningKey, getBytes } from 'ethers'
import { evmWalletInternals } from '../evm-wallet'
import { installCanonicalDirectory } from './evm-chain'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '../evm-transaction-set-types'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
const policy: EvmTransactionSetPolicy = {
  sourceOrder: [
    'stealth',
    'stamp',
    'change',
    'deterministic',
    'root',
    'identity',
  ],
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 210000n,
  radix: 2,
  jitterBps: 1500,
  maxChangeOutputs: 20,
  head: 100,
}
function roots() {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: getBytes('0x' + vectors.vectors[0].outputs[purpose]),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
async function setup() {
  offlineChain.reset()
  mockBalances.clear()
  useProviderStandIns()
  const f = await fixture({
    transactionSetPolicy: () => policy,
    spendSpacingBlocks: undefined,
    reserveBalanceWei: undefined,
  })
  const directory = await f.directoryFor('alice', f.alice, f.bob)
  installCanonicalDirectory(f.alice, directory)
  const main = f.alice.mainAccount!
  mockBalances.set(main.address.toLowerCase(), 1000000n)
  await evmWalletInternals(f.alice).coinList!.put({
    account: main.address,
    privateKey: main.privateKey,
    nonce: 0,
    valueWei: 1000000n,
    origin: 'root',
  })
  await f.alice.refreshTransactionSetInventory?.()
  return { ...f, directory }
}
afterEach(() => {
  jest.restoreAllMocks()
  useProviderStandIns(false)
})

test('wallet open and repeated idle recovery do not construct, sign, or broadcast funding', async () => {
  const f = await setup()
  try {
    expect('fundAhead' in f.chain.directMessages).toBe(false)
    const construct = jest.spyOn(f.alice.transactionSetPreparer!, 'constructTransactionSet')
    const sign = jest.spyOn(SigningKey.prototype, 'sign')
    const before = f.alice.getNativeOperations!()
    await f.alice.reobserveNativeOperations!()
    await f.alice.reobserveNativeOperations!()
    expect(construct).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(offlineChain.walletBroadcasts).toEqual([])
    expect(f.alice.getNativeOperations!()).toEqual(before)
  } finally {
    await f.close()
  }
})

test.each(['before broadcast', 'ambiguous broadcast'] as const)(
  'reopens historical funding %s and recovers only the original signed operation',
  async interruption => {
    const f = await setup()
    let active: EvmChainWalletHandle = f.alice
    try {
      const target = active.pool.deriveNextUnfunded()
      await active.pool.flush()
      const operationId = `stamp-fund-ahead-${target.index}`
      // Seed the exact durable artifact produced by the removed workflow. No public
      // prefunding API exists; recovery may only finish this already-authorized set.
      const prepared = await active.transactionSetPreparer!.constructTransactionSet({
        operationId,
        amountWei: 300000n,
        kdf: () => target.address,
      })
      const original = active.transactionSetPreparer!.getOperation(operationId)!
      const bytes = original.members.map(member => member.signed!.rawTransaction)
      if (interruption === 'ambiguous broadcast') {
        offlineChain.broadcastDown = true
        await expect(active.transactionSetLifecycle!.replay(operationId, { payments: true }))
          .rejects.toThrow()
        expect(active.transactionSetPreparer!.getOperation(operationId)!.members.some(member => member.exposed))
          .toBe(true)
      }
      await active.close()
      offlineChain.broadcastDown = false
      providerRequests.length = 0
      chainHttpRequests.length = 0
      const sign = jest.spyOn(SigningKey.prototype, 'sign')
      active = await f.chain.createWallet(roots()) as EvmChainWalletHandle
      installCanonicalDirectory(active, f.directory)
      expect(providerRequests).toEqual([])
      expect(chainHttpRequests).toEqual([])
      expect(sign).not.toHaveBeenCalled()
      expect(active.transactionSetPreparer!.getOperation(operationId)!.members.map(member => member.signed!.rawTransaction))
        .toEqual(bytes)
      expect(evmWalletInternals(active).coinList!.heldBy(operationId)).toHaveLength(bytes.length)
      const construct = jest.spyOn(active.transactionSetPreparer!, 'constructTransactionSet')
      await active.reobserveNativeOperations!()
      await active.reobserveNativeOperations!()
      expect(construct).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      expect(offlineChain.walletBroadcasts.length).toBeGreaterThan(0)
      expect(offlineChain.walletBroadcasts.every(raw => bytes.includes(raw))).toBe(true)
      expect(active.getNativeOperations!().filter(row => row.kind === 'transaction-set')).toHaveLength(1)
      const after = active.transactionSetPreparer!.getOperation(operationId)!
      expect(after.members.map(member => member.signed!.rawTransaction)).toEqual(bytes)
      expect(after.members.every(member => member.observation.state === 'included-success')).toBe(true)
      expect(prepared.bundle).toHaveLength(1)
    } finally {
      await active.close()
      await f.close()
    }
  },
)

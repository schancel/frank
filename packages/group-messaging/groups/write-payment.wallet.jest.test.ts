/**
 * A group write paid through the real EVM wallet: real typed custody, coin list and LevelDB
 * transaction-set journal. Only the node and the relay are the wallet suite's established
 * stand-ins (`@frank/wallet/chain/canonical-two-wallets.testutil`): the node records every
 * broadcast the wallet makes, and "the relay broadcasts" is the node mining the bytes it was
 * handed.
 */
import { Transaction, hexlify } from 'ethers'
import { GroupWriteRefusedError } from '@frank/cashweb/groups/group-relay-client'
import {
  GROUP_WRITE_BURN_ADDRESS,
  type GroupWritePaymentWire,
  type GroupWritePolicy,
  type StoredGroupWritePayment,
} from '@frank/cashweb/groups/group-write-payment'
import {
  fixture,
  mockBalances,
  offlineChain,
  roots,
  useProviderStandIns,
} from '@frank/wallet/chain/canonical-two-wallets.testutil'
import { evmWalletInternals } from '@frank/wallet/evm-wallet'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '@frank/wallet/evm-transaction-set-types'
import {
  GroupWritePaidRefusalError,
  deliverPaidGroupWrite,
} from './write-payment'

jest.mock('@frank/wallet/evm-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('@frank/wallet/evm-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
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
  paymentGasLimit: () => 30_000n,
  changeGasLimit: 21_000n,
  paymentFeeIsExact: true,
  dustWei: 210_000n,
  radix: 2,
  jitterBps: 1_500,
  maxChangeOutputs: 20,
  head: 100,
}
const HOST: GroupWritePolicy = {
  network: 'monad-testnet',
  priceWei: 1_000n,
  hostOrigin: 'https://relay.example',
  payee: { kind: 'burn', address: GROUP_WRITE_BURN_ADDRESS },
}
const GROUP = '11'.repeat(32)
const envelope = (byte: string) => ({
  epoch: 0,
  nonce: byte.repeat(24),
  ciphertext: byte.repeat(80),
  write_sig: '55'.repeat(64),
})

async function setup() {
  offlineChain.reset()
  mockBalances.clear()
  useProviderStandIns()
  const f = await fixture({
    transactionSetPolicy: () => policy,
    spendSpacingBlocks: undefined,
    reserveBalanceWei: undefined,
  })
  const main = f.alice.mainAccount!
  mockBalances.set(main.address.toLowerCase(), 1_000_000n)
  await evmWalletInternals(f.alice).coinList!.put({
    account: main.address,
    privateKey: main.privateKey,
    nonce: 0,
    valueWei: 1_000_000n,
    origin: 'root',
  })
  await f.alice.refreshTransactionSetInventory?.()
  return f
}
afterEach(() => {
  jest.restoreAllMocks()
  useProviderStandIns(false)
})

function message() {
  let stored: StoredGroupWritePayment | undefined
  return {
    get stored() {
      return stored
    },
    persist: async (next: StoredGroupWritePayment) => {
      stored = next
    },
  }
}

function deliver(
  wallet: EvmChainWalletHandle,
  record: ReturnType<typeof message>,
  submit: (payment: GroupWritePaymentWire) => Promise<unknown>,
  byte = '33',
) {
  return deliverPaidGroupWrite({
    groupIdHex: GROUP,
    envelope: envelope(byte),
    stored: record.stored,
    policy: async () => HOST,
    persist: record.persist,
    wallet,
    submit,
  })
}

/** What the wallet itself broadcast of the payment (its own change members excluded). */
const walletPaymentBroadcasts = () =>
  offlineChain.walletBroadcasts
    .map(raw => hexlify(raw))
    .filter(raw => Transaction.from(raw).to === GROUP_WRITE_BURN_ADDRESS)

/** Every payment to the burn address that is on the (stand-in) chain. */
const minedPayments = () =>
  [...offlineChain.signedTransactions.values()].filter(
    raw => Transaction.from(raw).to === GROUP_WRITE_BURN_ADDRESS,
  )

test('the wallet broadcasts only after the relay holds the write', async () => {
  const f = await setup()
  try {
    const record = message()
    const broadcastsAtRelay: number[] = []
    const delivered = await deliver(f.alice, record, async payment => {
      broadcastsAtRelay.push(offlineChain.walletBroadcasts.length)
      offlineChain.mine(`0x${payment.raw_transaction}`) // the relay stored it and broadcast
      return { server_seq: 1 }
    })
    expect(delivered).toMatchObject({ state: 'delivered', settled: true })
    expect(broadcastsAtRelay).toEqual([0])
    expect(minedPayments()).toEqual([`0x${record.stored!.rawTransaction}`])
    // After the relay holds the write the wallet broadcasts its whole set, the payment among its
    // own self-sends in whatever order construction drew, each account's nonces in order.
    const byAccount = new Map<string, number[]>()
    for (const raw of offlineChain.walletBroadcasts) {
      const tx = Transaction.from(hexlify(raw))
      byAccount.set(tx.from!, [...(byAccount.get(tx.from!) ?? []), tx.nonce])
    }
    for (const nonces of byAccount.values())
      expect(nonces).toEqual([...nonces].sort((a, b) => a - b))
  } finally {
    await f.close()
  }
})

test('a refused write leaves no broadcast and gives its coin back', async () => {
  const f = await setup()
  try {
    const coins = evmWalletInternals(f.alice).coinList!
    const account = f.alice.mainAccount!.address
    const before = coins.get(account, 0)
    expect(before).toBeDefined()
    const record = message()
    const refused = await deliver(f.alice, record, async () => {
      throw new GroupWriteRefusedError(
        402,
        'group_payment_invalid',
        'underpaid',
      )
    })
    expect(refused).toMatchObject({ state: 'refused', outcome: 'released' })
    expect(offlineChain.walletBroadcasts).toEqual([])
    expect(minedPayments()).toEqual([])
    expect(
      f.alice.transactionSetPreparer!.getOperation(record.stored!.operationId),
    ).toBeUndefined()
    // The coin is back as it was, unreserved, and the next write can spend it.
    expect(coins.get(account, 0)).toEqual(before)
    expect(coins.isAccountReserved(account)).toBe(false)
    const next = message()
    expect(
      await deliver(f.alice, next, async () => ({ server_seq: 1 }), '44'),
    ).toMatchObject({ state: 'delivered', settled: true })
  } finally {
    await f.close()
  }
})

test('a refusal after an uncertain attempt keeps the coin and tracks the mined payment', async () => {
  const f = await setup()
  try {
    const record = message()
    await expect(
      deliver(f.alice, record, async payment => {
        offlineChain.mine(`0x${payment.raw_transaction}`) // stored and broadcast, answer lost
        throw new Error('timeout of 15000ms exceeded')
      }),
    ).rejects.toThrow('timeout')
    await expect(
      deliver(f.alice, record, async () => {
        throw new GroupWriteRefusedError(
          402,
          'group_payment_invalid',
          'underpaid',
        )
      }),
    ).rejects.toBeInstanceOf(GroupWritePaidRefusalError)
    expect(record.stored).toMatchObject({ spent: true })
    expect(record.stored!.released).toBeUndefined()
    // Authorized and reconciled from the chain: the wallet holds the mined payment, and did
    // not send it again.
    const operation = f.alice.transactionSetPreparer!.getOperation(
      record.stored!.operationId,
    )
    expect(operation?.submissionAuthorized).toBe(true)
    expect(walletPaymentBroadcasts()).toEqual([])
  } finally {
    await f.close()
  }
})

test('a timeout then a retry gives one payment', async () => {
  const f = await setup()
  try {
    const record = message()
    const submitted: string[] = []
    await expect(
      deliver(f.alice, record, async payment => {
        submitted.push(payment.raw_transaction)
        offlineChain.mine(`0x${payment.raw_transaction}`)
        throw new Error('timeout of 15000ms exceeded')
      }),
    ).rejects.toThrow('timeout')
    expect(offlineChain.walletBroadcasts).toEqual([])
    const retried = await deliver(f.alice, record, async payment => {
      submitted.push(payment.raw_transaction)
      return { server_seq: 1 }
    })
    expect(retried).toMatchObject({ state: 'delivered', settled: true })
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toBe(submitted[0])
    expect(minedPayments()).toHaveLength(1)
    // The wallet found the relay's copy on chain and did not send the payment again.
    expect(walletPaymentBroadcasts()).toEqual([])
  } finally {
    await f.close()
  }
})

test('a restart between signing and relay submission resumes with the same bytes', async () => {
  const f = await setup()
  let reopened: EvmChainWalletHandle | undefined
  try {
    const record = message()
    await expect(
      deliver(f.alice, record, async () => {
        throw new Error('process stopped before the relay call')
      }),
    ).rejects.toThrow('process stopped')
    const signed = record.stored!.rawTransaction!
    expect(offlineChain.walletBroadcasts).toEqual([])
    await f.alice.close()
    reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    const submitted: string[] = []
    const resumed = await deliver(reopened, record, async payment => {
      submitted.push(payment.raw_transaction)
      expect(offlineChain.walletBroadcasts).toEqual([])
      return { server_seq: 1 }
    })
    expect(resumed).toMatchObject({ state: 'delivered', settled: true })
    expect(submitted).toEqual([signed])
    // Nobody else broadcast it, so the wallet did, after the relay held the write.
    expect(walletPaymentBroadcasts().map(raw => raw.slice(2))).toEqual([signed])
    expect(minedPayments()).toHaveLength(1)
  } finally {
    await reopened?.close()
    await f.close()
  }
})

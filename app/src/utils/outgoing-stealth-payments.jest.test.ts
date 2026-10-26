import type { StealthPaymentStatus } from '@frank/wallet/stealth-payment'
import {
  outgoingStealthPayments,
  refreshOutgoingStealthPayments,
  type StealthPaymentOwner,
} from './outgoing-stealth-payments'
import { sentStealthAssetDetail } from './stealth-transaction-details'

const HASH_A = '0x' + 'a7'.repeat(32)
const HASH_B = '0x' + 'b8'.repeat(32)
const DIGEST = 'f6'.repeat(32)

const sentMessage = (over: Record<string, unknown> = {}) => ({
  outbound: true,
  payloadDigest: 'local-digest',
  delivery: { attemptDigest: DIGEST },
  items: [{ type: 'stealth-asset' }],
  ...over,
})

const item = {
  transfers: [HASH_A, HASH_B].map(hash => ({
    chainIdentifier: 'monad-regtest',
    txId: hash.slice(2),
  })),
}

const status = (
  over: Partial<StealthPaymentStatus> & {
    states?: ('unsent' | 'pending' | 'landed' | 'failed')[]
  } = {},
): StealthPaymentStatus => {
  const { states = ['unsent', 'unsent'], ...rest } = over
  return {
    status: 'pending',
    intendedAmountAtomic: 2000n,
    submitted: false,
    members: [HASH_A, HASH_B].map((txHash, index) => ({
      txHash,
      recipientAmountAtomic: 1000n,
      state: states[index] ?? 'unsent',
    })),
    ...rest,
  }
}

/** A wallet whose journal answers `journal` for the payment bound to `DIGEST`. */
function owner(journal: { now: StealthPaymentStatus | undefined }) {
  const asked: string[] = []
  const wallet: StealthPaymentOwner = {
    chainIdentifier: 'monad-regtest',
    stealthPayments: {
      list: async () => [
        { operationId: 'op-1', payloadDigest: DIGEST },
        { operationId: 'op-other', payloadDigest: 'cc'.repeat(32) },
        { operationId: 'op-unbound' },
      ],
      status: async id => {
        asked.push(id)
        return id === 'op-1' ? journal.now : undefined
      },
    },
  }
  return { wallet, asked }
}

const shown = () =>
  sentStealthAssetDetail(outgoingStealthPayments.get(DIGEST), item)

beforeEach(() => outgoingStealthPayments.clear())

test('the card follows the journal from not sent to pending to partly landed to paid, and reads it again after a reload', async () => {
  const journal = { now: status() as StealthPaymentStatus | undefined }
  const { wallet, asked } = owner(journal)
  const messages = [sentMessage()]

  // Before the first read: nothing is claimed.
  expect(shown()).toEqual({ state: 'unknown' })

  expect(await refreshOutgoingStealthPayments([wallet], messages)).toBe(1)
  expect(asked).toEqual(['op-1'])
  expect(shown().state).toBe('unsent')

  journal.now = status({ submitted: true, states: ['pending', 'pending'] })
  await refreshOutgoingStealthPayments([wallet], messages)
  expect(shown().state).toBe('pending')

  journal.now = status({
    status: 'partial',
    submitted: true,
    verifiedReceivedAmountAtomic: 1000n,
    states: ['landed', 'pending'],
  })
  await refreshOutgoingStealthPayments([wallet], messages)
  expect(shown()).toMatchObject({
    state: 'partial',
    payment: { verifiedReceivedAmountAtomic: 1000n },
  })

  // A reload: the view is empty and is read again from the journal.
  outgoingStealthPayments.clear()
  expect(shown().state).toBe('unknown')
  await refreshOutgoingStealthPayments([wallet], messages)
  expect(shown().state).toBe('partial')

  journal.now = status({
    status: 'succeeded',
    submitted: true,
    verifiedReceivedAmountAtomic: 2000n,
    nativeFeeAtomic: 42000n,
    states: ['landed', 'landed'],
  })
  expect(await refreshOutgoingStealthPayments([wallet], messages)).toBe(0)
  expect(shown()).toMatchObject({
    state: 'paid',
    payment: { verifiedReceivedAmountAtomic: 2000n, nativeFeeAtomic: 42000n },
  })

  // Final: not asked again.
  asked.length = 0
  await refreshOutgoingStealthPayments([wallet], messages)
  expect(asked).toEqual([])
})

test('a payment whose every transfer failed reads failed, never paid', async () => {
  const journal = {
    now: status({
      status: 'failed',
      submitted: true,
      states: ['failed', 'failed'],
    }) as StealthPaymentStatus | undefined,
  }
  await refreshOutgoingStealthPayments([owner(journal).wallet], [sentMessage()])
  expect(shown().state).toBe('chainFailed')
})

test('only the journal entry for exactly these transfers on this chain is believed', async () => {
  const journal = {
    now: status({
      status: 'succeeded',
      submitted: true,
      states: ['landed', 'landed'],
    }) as StealthPaymentStatus | undefined,
  }
  await refreshOutgoingStealthPayments([owner(journal).wallet], [sentMessage()])
  const payments = outgoingStealthPayments.get(DIGEST)
  expect(
    sentStealthAssetDetail(payments, {
      transfers: [{ chainIdentifier: 'monad-regtest', txId: HASH_A.slice(2) }],
    }),
  ).toEqual({ state: 'unknown' })
  expect(
    sentStealthAssetDetail(payments, {
      transfers: item.transfers.map(transfer => ({
        ...transfer,
        chainIdentifier: 'monad-testnet',
      })),
    }),
  ).toEqual({ state: 'unknown' })
})

test('messages without a stealth payment, received ones, and wallets that cannot say are left alone', async () => {
  const journal = { now: status() as StealthPaymentStatus | undefined }
  const { wallet, asked } = owner(journal)
  const failing: StealthPaymentOwner = {
    chainIdentifier: 'monad-regtest',
    stealthPayments: {
      list: async () => {
        throw new Error('locked')
      },
      status: async () => undefined,
    },
  }
  const mute: StealthPaymentOwner = {
    chainIdentifier: 'monad-regtest',
    stealthPayments: { list: async () => [] },
  }
  expect(
    await refreshOutgoingStealthPayments(
      [failing, mute, wallet],
      [
        sentMessage({ items: [{ type: 'text' }] }),
        sentMessage({ outbound: false }),
      ],
    ),
  ).toBe(0)
  expect(asked).toEqual([])
  // A wallet that throws does not stop another from answering.
  expect(
    await refreshOutgoingStealthPayments([failing, wallet], [sentMessage()]),
  ).toBe(1)
  expect(shown().state).toBe('unsent')
})

test('a payment whose transfers landed before its fee was known is read again until the fee is known', async () => {
  const journal = {
    now: status({
      status: 'succeeded',
      submitted: true,
      verifiedReceivedAmountAtomic: 2000n,
      states: ['landed', 'landed'],
    }) as StealthPaymentStatus | undefined,
  }
  const { wallet, asked } = owner(journal)
  const messages = [sentMessage()]
  // The transfers landed; their change has not yet, so the fee is not known.
  expect(await refreshOutgoingStealthPayments([wallet], messages)).toBe(1)
  expect(shown().payment?.nativeFeeAtomic).toBeUndefined()
  journal.now = { ...journal.now!, nativeFeeAtomic: 42000n }
  asked.length = 0
  expect(await refreshOutgoingStealthPayments([wallet], messages)).toBe(0)
  expect(asked).toEqual(['op-1'])
  expect(shown().payment?.nativeFeeAtomic).toBe(42000n)
})

test('a Send to Contact payment another device sent reads as the chain shows it, with the fee its operation paid', async () => {
  const { Wallet } = await import('ethers')
  const { resolveChainIdentifier } = await import(
    '@frank/wallet/chain/chains-registry'
  )
  const chain = resolveChainIdentifier('monad-regtest')!
  const signer = Wallet.createRandom()
  const to = '0x' + '5c'.repeat(20)
  const rawTx = await signer.signTransaction({
    type: 2,
    chainId: 20143n, // monad-regtest (docs/protocol/chains/v1.json)
    nonce: 0,
    to,
    value: 500n,
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
  const { Transaction } = await import('ethers')
  const txHash = Transaction.from(rawTx).hash!.toLowerCase()
  const operation = { id: 'evm-transaction-set:contact-' + 'ab'.repeat(16) }
  const noted = (hash: string, feeWei: string, stage?: string) => ({
    txHash: hash,
    from: signer.address.toLowerCase(),
    nonce: 0,
    to,
    valueWei: '1',
    call: false,
    purpose: 'contact-payment' as const,
    operation: stage ? { ...operation, stage } : operation,
    noteIndex: 0,
    notedAtMs: 1,
    state: 'included' as const,
    inclusion: {
      status: 'success' as const,
      blockNumber: 1,
      blockHash: '0x' + '01'.repeat(32),
      feeWei,
    },
  })
  const notes = [
    noted(txHash, '30'),
    // Its change, and the message's stamp appended to it (not the payment's fee).
    noted('0x' + 'c1'.repeat(32), '12'),
    noted('0x' + 'c2'.repeat(32), '99', 'stamp-' + 'ab'.repeat(16)),
  ]
  const other: StealthPaymentOwner = {
    chainIdentifier: chain.id,
    // This device's journal has no record of it.
    stealthPayments: { list: async () => [], status: async () => undefined },
    evmReader: {
      getTransactionReceipt: async hash =>
        hash.toLowerCase() === txHash ? { to, status: 1 } : null,
    },
    getNotedSends: async () => notes,
  }
  const message = sentMessage({
    items: [
      {
        type: 'stealth',
        networkTag: chain.id,
        transactions: [rawTx.slice(2)],
      },
    ],
  })
  expect(await refreshOutgoingStealthPayments([other], [message])).toBe(0)
  const detail = sentStealthAssetDetail(outgoingStealthPayments.get(DIGEST), {
    transfers: [{ chainIdentifier: chain.id, txId: txHash }],
  })
  expect(detail.state).toBe('paid')
  expect(detail.payment?.nativeFeeAtomic).toBe(42n)
})

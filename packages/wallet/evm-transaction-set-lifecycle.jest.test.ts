/** Replay scheduling unit tests; scripted node replies do not prove chain conformance. */
import { Transaction, Wallet } from 'ethers'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import type {
  EvmNativeOperation,
  EvmNativeMember,
} from './storage/evm-native-operation-journal'

const source = new Wallet('0x' + '11'.repeat(32))
const recipient = new Wallet('0x' + '22'.repeat(32)).address
const change = new Wallet('0x' + '33'.repeat(32)).address

async function fixture(paymentNonce: number) {
  const members = await Promise.all(
    [0, 1].map(async (nonce) => {
      const raw = await source.signTransaction({
        chainId: 10143,
        nonce,
        to: nonce === paymentNonce ? recipient : change,
        value: 1000n,
        gasLimit: 21000n,
        gasPrice: 1n,
      })
      const tx = Transaction.from(raw)
      return {
        source: {
          kind: 'coin' as const,
          address: source.address.toLowerCase(),
        },
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: nonce === 0 ? [] : [0],
        signed: { rawTransaction: raw, transactionHash: tx.hash! },
        exposed: false,
        observation: { state: 'unknown' as const },
        account: null,
        syncApplied: false,
        transactionSet: {
          role:
            nonce === paymentNonce ? ('payment' as const) : ('change' as const),
          logicalIndex: 0,
          balanceBeforeWei: '100000',
          balanceAfterWei: '0',
        },
      }
    }),
  )
  const operation: EvmNativeOperation = {
    version: 1,
    operationId: 'native:1',
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'fixture',
    },
    kind: 'native',
    recipient: recipient.toLowerCase(),
    intendedValueWei: '1000',
    maximumFeeWei: '42000',
    members,
    cancelled: false,
    reservedBytes: 0,
  }
  const accepted = new Set<string>()
  const broadcast = jest.fn(async (raw: string) => {
    const hash = Transaction.from(raw).hash!
    accepted.add(hash)
    return { hash }
  })
  const markExposed = jest.fn(async (_id: string, index: number) => {
    operation.members[index]!.exposed = true
  })
  const authority = {
    getOperation: () => operation,
    markExposed,
    recordObservation: jest.fn(async () => undefined),
  }
  const provider = {
    getTransaction: jest.fn(async (hash: string) =>
      accepted.has(hash) ? { hash } : null,
    ),
    broadcastTransaction: broadcast,
  }
  let head = 100
  const lifecycle = new EvmTransactionSetLifecycle({
    authority,
    provider,
    head: () => head,
  })
  return {
    operation,
    authority,
    provider,
    lifecycle,
    broadcast,
    setHead: (value: number) => {
      head = value
    },
  }
}

test('withholds a payment and its higher nonce change until relay acceptance', async () => {
  const f = await fixture(0)
  await f.lifecycle.replay('message', { payments: false })
  expect(f.broadcast).not.toHaveBeenCalled()
  await f.lifecycle.replay('message', { payments: true })
  expect(
    f.broadcast.mock.calls.map(([raw]) => Transaction.from(raw).nonce),
  ).toEqual([0, 1])
})

test('releases lower nonce change separately and retries the original exact bytes', async () => {
  const f = await fixture(1)
  await f.lifecycle.replay('message', { payments: false })
  expect(
    f.broadcast.mock.calls.map(([raw]) => Transaction.from(raw).to),
  ).toEqual([change])
  const original = f.operation.members.map((m) => m.signed!.rawTransaction)
  await f.lifecycle.replay('message', { payments: true })
  expect(f.broadcast.mock.calls.map(([raw]) => raw)).toEqual(original)
  expect(f.authority.markExposed.mock.calls).toEqual([
    ['message', 0],
    ['message', 0],
    ['message', 1],
  ])
})

test('a failed lower nonce handoff prevents successor broadcast while another source can progress', async () => {
  const f = await fixture(0)
  const unrelated = {
    ...f.operation.members[1]!,
    source: { kind: 'coin' as const, address: recipient.toLowerCase() },
    dependencies: [],
  } as EvmNativeMember
  f.operation.members.push(unrelated)
  f.broadcast.mockRejectedValueOnce(new Error('ambiguous node refusal'))
  await expect(
    f.lifecycle.replay('message', { payments: true }),
  ).rejects.toThrow('ambiguous node refusal')
  expect(f.broadcast.mock.calls).toHaveLength(2)
})

test('waits for the actual predecessor inclusion and quiet-block eligibility before the private final drain', async () => {
  const f = await fixture(0)
  Object.assign(f.operation.members[1]!, {
    transactionSet: { role: 'change', predecessorWaitBlocks: 3 },
  })
  await f.lifecycle.replay('message', { payments: true })
  expect(f.broadcast.mock.calls).toHaveLength(1)
  f.operation.members[0]!.observation = {
    state: 'included-success',
    transactionHash: f.operation.members[0]!.signed!.transactionHash,
    blockHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    transactionIndex: 0,
    feeWei: '21000',
  }
  f.setHead(102)
  await f.lifecycle.replay('message', { payments: true })
  expect(f.broadcast.mock.calls).toHaveLength(1)
  f.setHead(103)
  await f.lifecycle.replay('message', { payments: true })
  expect(
    f.broadcast.mock.calls.map(([raw]) => Transaction.from(raw).nonce),
  ).toEqual([0, 1])
})

test.each(['included-revert', 'superseded'] as const)('never declares a %s payment ready for relay exposure', async failure => {
  const f = await fixture(0)
  const member = f.operation.members[0]!, tx = Transaction.from(member.signed!.rawTransaction)
  member.observation = failure === 'included-revert' ? {
    state: 'included-revert', transactionHash: tx.hash!, blockHash: '0x' + '11'.repeat(32), blockNumber: 1, transactionIndex: 0, feeWei: '21000',
  } : { state: 'missing' }
  member.account = { blockHash: '0x' + '11'.repeat(32), blockNumber: 1, nonce: tx.nonce + 1, balanceWei: '0' }
  expect(f.lifecycle.canSubmitPayments('message')).toBe(false)
  member.observation = { state: 'included-success', transactionHash: tx.hash!, blockHash: '0x' + '11'.repeat(32), blockNumber: 1, transactionIndex: 0, feeWei: '21000' }
  expect(f.lifecycle.canSubmitPayments('message')).toBe(true)
})

import axios from 'axios'
import { Wallet, Transaction, getBytes, hexlify } from 'ethers'
import {
  encodeForumPost,
  encodeTopicPostSubmission,
  encodeFrame,
  topicBurnCommitment,
  topicBurnCalldata,
} from '@frank/codec'
import { MonadHdKeyring } from './monad-hd-keyring'
import { createInMemoryMonadWalletBundle } from './storage/monad-wallet-bundle'
import {
  bindForumAuthority,
  classifyForumOperation,
  reconcileForumOperations,
  MAX_FORUM_BURN,
} from './monad-forum-operation'
import type { OutgoingTopicOperation } from './storage/topic-operation-journal'
import type { EvmWalletHandle } from "./evm-wallet-handle";
jest.mock('axios')
const http = axios as jest.MockedFunction<typeof axios>
const mnemonic = 'test test test test test test test test test test test junk'
const burn = '0x000000000000000000000000000000000000dEaD'

async function fixture() {
  const bundle = createInMemoryMonadWalletBundle({ mnemonic })
  bundle.pool.ensureSize(1)
  const lease = bundle.leaseManager.acquireLease()
  const key = MonadHdKeyring.fromMnemonic(mnemonic).deriveSubAccount(
    lease.index,
  )
  const post = encodeForumPost({
    network: 'monad-testnet',
    topic: 'test',
    authored: { seconds: 0n, nanoseconds: 0 },
    entries: [{ message: 'hello' }],
  })
  const { hash, commitment } = topicBurnCommitment(post)
  const raw = await new Wallet(key.privateKey).signTransaction({
    chainId: 10143n,
    to: burn,
    value: 7n,
    data: hexlify(topicBurnCalldata('up', commitment)),
    nonce: 0,
    gasLimit: 60000n,
    gasPrice: 1n,
  })
  const tx = Transaction.from(raw)
  const request = encodeTopicPostSubmission(post, getBytes(raw))
  const operation: OutgoingTopicOperation = {
    version: 1,
    kind: 'post',
    writeFormat: 'forum-cbor',
    requestBytes: Array.from(request),
    leaseIndex: lease.index,
    senderAddress: key.address,
    rawTx: raw,
    txHash: tx.hash!,
    valueWei: '7',
    direction: 'up',
    payloadHashHex: hexlify(hash).slice(2),
  }
  await bundle.topicOperationJournal.put(operation)
  const receipt = {
    hash: tx.hash,
    from: key.address,
    to: burn,
    status: 1,
    blockNumber: 0,
    index: 0,
  }
  const observed = {
    hash: tx.hash,
    from: key.address,
    to: burn,
    chainId: 10143n,
    value: 7n,
    data: tx.data,
    blockNumber: 0,
    index: 0,
  }
  const provider = {
    getNetwork: jest.fn(async () => ({ chainId: 10143n })),
    getTransactionReceipt: jest.fn(async () => receipt),
    getTransaction: jest.fn(async () => observed),
  }
  const wallet: EvmWalletHandle = {
    pool: bundle.pool,
    leaseManager: bundle.leaseManager,
    walletState: bundle,
    topicOperationJournal: bundle.topicOperationJournal,
    provider: provider as any,
    httpClient: {} as any,
    relayBaseUrl: 'http://localhost',
    cborNetwork: 'monad-testnet',
    forumBurnAddress: burn,
    forumChainId: 10143n,
  }
  function status(changes = new Map<number, any>()) {
    const fields = new Map<number, any>([
      [0, 'monad-testnet'],
      [1, request],
      [2, hash],
      [3, getBytes(tx.hash!)],
      [4, getBytes(key.address)],
      [5, 1],
      [6, 7n],
      [7, 2],
      [8, 0n],
      [9, 0n],
      [10, 0n],
      [11, new Uint8Array(16)],
    ])
    for (const [k, v] of changes)
      v === undefined ? fields.delete(k) : fields.set(k, v)
    return encodeFrame(
      { typeId: 15, schemaVersion: 1, minReaderVersion: 1 },
      fields,
    )
  }
  return {
    bundle,
    operation,
    wallet,
    provider,
    status,
    request,
    receipt,
    observed,
  }
}
const response = (data: Uint8Array) => ({
  data,
  headers: { 'content-type': 'application/cbor' },
})
afterEach(() => jest.clearAllMocks())

test('exact successful receipt with zero block/index settles and removes only canonical authority', async () => {
  const f = await fixture()
  http.mockResolvedValue(response(f.status()) as any)
  await reconcileForumOperations(f.wallet, 'post')
  expect(http.mock.calls[0][0]).toMatchObject({
    method: 'post',
    data: f.request,
    url: 'http://localhost/message/monad/topics/status',
  })
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  // Compaction is permitted only after exact settlement.
  expect(f.bundle.pool.getRecord(0)?.status ?? 'compacted').not.toBe('in-use')
  await f.bundle.close()
})

test.each([undefined, 'protobuf', 'cbor'] as const)(
  'old %s rows skip before decoding/provider/network/status/delete',
  async format => {
    const f = await fixture()
    await f.bundle.topicOperationJournal.delete(f.operation)
    const old = {
      ...f.operation,
      requestBytes: [255],
      rawTx: 'not-decodable',
      ...(format ? { writeFormat: format } : {}),
    } as any
    if (!format) delete old.writeFormat
    await f.bundle.topicOperationJournal.put(old)
    const before = JSON.stringify(f.bundle.topicOperationJournal.getAll())
    expect(classifyForumOperation(old)).toBe('unsupported-retained')
    await reconcileForumOperations(f.wallet, 'post')
    expect(JSON.stringify(f.bundle.topicOperationJournal.getAll())).toBe(before)
    expect(http).not.toHaveBeenCalled()
    expect(f.provider.getNetwork).not.toHaveBeenCalled()
    expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
    await f.bundle.close()
  },
)

test.each([0, 1, 3])(
  'state %s preserves pending exact bytes and replays without signing',
  async state => {
    const f = await fixture()
    const sign = jest.spyOn(f.wallet.pool, 'getSigner')
    http.mockResolvedValue(
      response(
        f.status(
          new Map([
            [7, state],
            [8, undefined],
            [9, undefined],
          ]),
        ),
      ) as any,
    )
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow()
    expect(http.mock.calls.map(([p]) => (p as any).data)).toEqual([
      f.request,
      f.request,
    ])
    expect(sign).not.toHaveBeenCalled()
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
    expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
    await f.bundle.close()
  },
)

test.each([
  [0, 'monad-mainnet'],
  [2, new Uint8Array(32).fill(9)],
  [3, new Uint8Array(32).fill(9)],
  [4, new Uint8Array(20).fill(9)],
  [5, 0],
  [6, 8n],
  [8, 1n],
  [9, 1n],
] as [number, any][])(
  'mismatched status field %s never settles',
  async (key, value) => {
    const f = await fixture()
    http.mockResolvedValue(response(f.status(new Map([[key, value]]))) as any)
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow()
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
    expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
    await f.bundle.close()
  },
)

test.each([
  'missing',
  'reverted',
  'wrong-from',
  'wrong-to',
  'wrong-hash',
  'wrong-block',
  'wrong-index',
])('receipt %s cannot erase authority', async mode => {
  const f = await fixture()
  if (mode === 'missing')
    f.provider.getTransactionReceipt.mockResolvedValue(null as any)
  if (mode === 'reverted') f.receipt.status = 0
  if (mode === 'wrong-from') f.receipt.from = burn
  if (mode === 'wrong-to') f.receipt.to = f.operation.senderAddress
  if (mode === 'wrong-hash') f.receipt.hash = '0x' + '99'.repeat(32)
  if (mode === 'wrong-block') f.receipt.blockNumber = 1
  if (mode === 'wrong-index') f.receipt.index = 1
  http.mockResolvedValue(response(f.status()) as any)
  await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow()
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
  expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
  await f.bundle.close()
})

test.each(['chain', 'destination', 'amount', 'sender', 'calldata', 'lease'])(
  'local %s mismatch rejects before transport',
  async mode => {
    const f = await fixture()
    if (mode === 'chain') f.wallet.forumChainId = 1n
    if (mode === 'destination')
      f.wallet.forumBurnAddress = f.operation.senderAddress
    if (mode === 'amount')
      f.operation.valueWei = (MAX_FORUM_BURN + 1n).toString()
    if (mode === 'sender') f.operation.senderAddress = burn
    if (mode === 'calldata') f.operation.direction = 'down'
    if (mode === 'lease') f.operation.leaseIndex = 999
    expect(() => bindForumAuthority(f.wallet, f.operation)).toThrow()
    expect(http).not.toHaveBeenCalled()
    await f.bundle.close()
  },
)

test('after lease flush before journal delete, missing historical evidence keeps authority', async () => {
  const f = await fixture()
  f.bundle.pool.recordSpendTransaction(0, {
    rawTx: f.operation.rawTx,
    txHash: f.operation.txHash,
    valueWei: f.operation.valueWei,
  })
  f.bundle.pool.setStatus(0, 'spent')
  f.provider.getTransactionReceipt.mockResolvedValue(null as any)
  http.mockResolvedValue(response(f.status()) as any)
  await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow()
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
  expect(f.bundle.pool.getRecord(0)!.status).toBe('spent')
  await f.bundle.close()
})

test.each(['value', 'input', 'chain', 'from', 'to', 'hash', 'block', 'index'])(
  'observed transaction %s mismatch preserves authority',
  async mode => {
    const f = await fixture()
    if (mode === 'value') f.observed.value = 8n
    if (mode === 'input') f.observed.data = '0x'
    if (mode === 'chain') f.observed.chainId = 1n
    if (mode === 'from') f.observed.from = burn
    if (mode === 'to') f.observed.to = f.operation.senderAddress
    if (mode === 'hash') f.observed.hash = '0x' + '99'.repeat(32)
    if (mode === 'block') f.observed.blockNumber = 1
    if (mode === 'index') f.observed.index = 1
    http.mockResolvedValue(response(f.status()) as any)
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow()
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
    expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
    await f.bundle.close()
  },
)

test('failed journal delete after exact confirmation retains authority until exact reconciliation', async () => {
  const f = await fixture()
  http.mockResolvedValue(response(f.status()) as any)
  const deletion = jest
    .spyOn(f.bundle.topicOperationJournal, 'delete')
    .mockRejectedValueOnce(new Error('disk failure'))
  await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow(
    'disk failure',
  )
  expect(f.bundle.pool.getRecord(0)!.status).toBe('spent')
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
  deletion.mockRestore()
  await reconcileForumOperations(f.wallet, 'post')
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  await f.bundle.close()
})

test('provider chain mismatch fails before relay transport and never settles', async () => {
  const f = await fixture()
  f.provider.getNetwork.mockResolvedValue({ chainId: 1n })
  await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow(
    'chain mismatch',
  )
  expect(http).not.toHaveBeenCalled()
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
  await f.bundle.close()
})

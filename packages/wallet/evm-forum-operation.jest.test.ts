import axios from 'axios'
import { Wallet, Transaction, getBytes, hexlify } from 'ethers'
import {
  encodeForumPost,
  encodeTopicPostSubmission,
  encodeFrame,
  topicBurnCommitment,
  topicBurnCalldata,
  TYPE_FORUM_OPERATION_STATUS,
} from '@frank/codec'
import { MonadHdKeyring } from './secp256k1-hd-keyring'
import { createInMemoryMonadWalletBundle } from './storage/evm-wallet-bundle'
import {
  bindForumAuthority,
  classifyForumOperation,
  reconcileForumOperations,
  submitForumOperation,
  MAX_FORUM_BURN,
} from './evm-forum-operation'
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
      { typeId: TYPE_FORUM_OPERATION_STATUS, schemaVersion: 1, minReaderVersion: 1 },
      fields,
    )
  }
  return {
    key,
    lease,
    post,
    hash,
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

test('submitForumOperation retries with bounded gas limit when signer throws CALL_EXCEPTION without gasLimit', async () => {
  const f = await fixture()
  f.bundle.leaseManager.releaseLease(f.lease, 'unused')
  await f.bundle.topicOperationJournal.delete(f.operation)
  const callException = Object.assign(new Error('missing revert data'), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
  })
  let callCount = 0
  let capturedGasLimit: bigint | undefined
  jest.spyOn(f.bundle.pool, 'getSigner').mockImplementation(() => ({
    buildAndSignCall: jest.fn(async (to: string, val: bigint, data: string, overrides?: any) => {
      callCount++
      if (callCount === 1 && overrides?.gasLimit === undefined) {
        throw callException
      }
      capturedGasLimit = overrides?.gasLimit
      return {
        rawTx: f.operation.rawTx,
        txHash: f.operation.txHash,
        from: f.key.address,
        to,
        value: val,
        data,
        gasLimit: overrides?.gasLimit ?? 21000n,
        maxFeePerGas: 2_000_000_000n,
        chainId: 10143n,
      }
    }),
  } as any))

  http.mockResolvedValue(response(f.status()) as any)

  const result = await submitForumOperation(f.wallet, {
    kind: 'post',
    target: f.hash,
    direction: 'up',
    burnAddress: burn,
    value: 7n,
    encode: (burnTx: Uint8Array) => encodeTopicPostSubmission(f.post, burnTx),
  })

  expect(callCount).toBe(2)
  expect(capturedGasLimit).toBeGreaterThan(21000n)
  expect(result.operation.txHash).toBe(f.operation.txHash)
  await f.bundle.close()
})


const relayError = (status: number, data: unknown, contentType = 'application/json') =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: { 'content-type': contentType } },
  })

// Exercise the production arraybuffer exchange, including retained authority on failure.
test.each(['arraybuffer', 'buffer', 'uint8array'] as const)(
  'Forum 503 JSON diagnostics survive %s responses without changing retained authority',
  async representation => {
    const f = await fixture()
    const bytes = Buffer.from(JSON.stringify({
      error: 'topic_burn_outcome_unknown',
      detail: 'ConfirmationTimedOut: receipt not observed',
    }))
    const data = representation === 'arraybuffer'
      ? Uint8Array.from(bytes).buffer
      : representation === 'uint8array' ? Uint8Array.from(bytes) : bytes
    const original = relayError(503, data, 'application/json; charset=utf-8')
    http.mockRejectedValue(original)
    const before = f.bundle.topicOperationJournal.getAll()
    const error = await reconcileForumOperations(f.wallet, 'post').catch(error => error)
    expect(error.message).toContain('HTTP 503')
    expect(error.message).toContain('topic_burn_outcome_unknown')
    expect(error.message).toContain('ConfirmationTimedOut: receipt not observed')
    expect(error.message).toContain('pending')
    expect(error).toMatchObject({
      status: 503,
      code: 'topic_burn_outcome_unknown',
      detail: 'ConfirmationTimedOut: receipt not observed',
      cause: original,
    })
    expect(f.bundle.topicOperationJournal.getAll()).toEqual(before)
    expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
    await f.bundle.close()
  },
)

test.each([
  [400, Buffer.from('{"error":"invalid_forum_request","detail":"invalid burn"}'), 'application/json', 'invalid_forum_request'],
  [503, Buffer.from('not JSON'), 'application/json', undefined],
  [503, Uint8Array.from([0xff]), 'application/json', undefined],
  [503, Buffer.from('null'), 'application/json', undefined],
  [503, Buffer.from('{"error":"unsafe code\\n","detail":"wait"}'), 'application/json', undefined],
  [429, Buffer.from('{"error":"rate_limited","detail":"wait"}'), 'text/html', undefined],
  [502, Buffer.alloc(4097, 32), 'application/json', undefined],
  [503, Buffer.from('{"error":[],"detail":{}}'), 'application/json', undefined],
  [503, Buffer.from(JSON.stringify({ error: 'forum_unavailable', detail: 'x'.repeat(1025) })), 'application/json', undefined],
  [503, { error: 'forum_unavailable', detail: 'object is not a byte response' }, 'application/json', undefined],
] as const)('Forum HTTP %s uses bounded diagnostics or a status-preserving fallback', async (status, data, media, code) => {
  const f = await fixture()
  const original = relayError(status, data, media)
  http.mockRejectedValue(original)
  const error = await reconcileForumOperations(f.wallet, 'post').catch(error => error)
  expect(error.message).toContain(`HTTP ${status}`)
  expect(error.cause).toBe(original)
  expect(error.code).toBe(code)
  expect(error.message.length).toBeLessThan(1400)
  expect(error.message).not.toContain('payment failed')
  await f.bundle.close()
})

test('Forum diagnostics redact upstream URLs and normalize control characters', async () => {
  const f = await fixture()
  http.mockRejectedValue(relayError(503, Buffer.from(JSON.stringify({
    error: 'topic_burn_outcome_unknown',
    detail: 'RPC https://upstream.invalid/private-token failed\nreceipt pending',
  }))))
  const error = await reconcileForumOperations(f.wallet, 'post').catch(error => error)
  expect(error.detail).toBe('RPC [URL redacted] failed receipt pending')
  expect(error.message).not.toContain('private-token')
  await f.bundle.close()
})

test('Forum JSON decoding respects a byte view offset and length', async () => {
  const f = await fixture()
  const payload = Buffer.from('{"error":"forum_unavailable","detail":"wait"}')
  const padded = Buffer.concat([Buffer.from('not JSON'), payload, Buffer.from('trailing')])
  http.mockRejectedValue(relayError(503, padded.subarray(8, 8 + payload.length)))
  const error = await reconcileForumOperations(f.wallet, 'post').catch(error => error)
  expect(error.code).toBe('forum_unavailable')
  expect(error.detail).toBe('wait')
  await f.bundle.close()
})

test('initial Forum submission retains diagnostic cause and signed operation after HTTP 503', async () => {
  const f = await fixture()
  f.bundle.leaseManager.releaseLease(f.lease, 'unused')
  await f.bundle.topicOperationJournal.delete(f.operation)
  jest.spyOn(f.bundle.pool, 'getSigner').mockReturnValue({
    buildAndSignCall: jest.fn(async () => ({
      rawTx: f.operation.rawTx,
      txHash: f.operation.txHash,
      from: f.key.address,
      value: 7n,
    })),
  } as any)
  const original = relayError(503, Uint8Array.from(Buffer.from(JSON.stringify({
    error: 'topic_burn_outcome_unknown', detail: 'ConfirmationTimedOut',
  }))).buffer)
  http.mockRejectedValue(original)
  const error = await submitForumOperation(f.wallet, {
    kind: 'post', target: f.hash, direction: 'up', burnAddress: burn, value: 7n,
    encode: raw => encodeTopicPostSubmission(f.post, raw),
  }).catch(error => error)
  expect(error.message).toContain('HTTP 503 (topic_burn_outcome_unknown): ConfirmationTimedOut')
  expect(error.cause.cause).toBe(original)
  expect(http).toHaveBeenCalledTimes(1)
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([f.operation])
  expect(f.bundle.pool.getRecord(0)!.status).toBe('in-use')
  await f.bundle.close()
})

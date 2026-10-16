import {
  MonadTopicPostClient,
  MonadTopicPostAbandonedError,
  quoteMonadTopicBurnGasReserve,
} from './monad-topic-post-client'
import axios from 'axios'
import { Wallet, Transaction, getBytes, hexlify, getAddress } from 'ethers'
import {
  encodeFrame,
  validateFrame,
  defaultContext,
  topicBurnCommitment,
  toHex,
  verifyTopicPostAuthor,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/monad-wallet-bundle'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadIdentity } from './monad-identity'
import type { EvmWalletHandle } from "./evm-wallet-handle";
jest.mock('axios')
const http = axios as jest.MockedFunction<typeof axios>
const mnemonic = 'test test test test test test test test test test test junk'
const burn = '0x000000000000000000000000000000000000dEaD'
async function fixture() {
  const bundle = createInMemoryMonadWalletBundle({ mnemonic })
  await bundle.pool.ensureSize(2)
  const signed: Transaction[] = []
  const signer = jest.spyOn(bundle.pool, 'getSigner').mockImplementation(
    (index: number) =>
      ({
        buildAndSignCall: jest.fn(
          async (to: string, value: bigint, data: string) => {
            const key =
              MonadHdKeyring.fromMnemonic(mnemonic).deriveSubAccount(index)
            const rawTx = await new Wallet(key.privateKey).signTransaction({
              chainId: 10143n,
              to,
              value,
              data,
              nonce: 0,
              gasLimit: 60000n,
              gasPrice: 1n,
            })
            const tx = Transaction.from(rawTx)
            signed.push(tx)
            return {
              rawTx,
              txHash: tx.hash!,
              from: tx.from!,
              to,
              value,
              data,
              chainId: 10143n,
            }
          },
        ),
      } as any),
  )
  const provider = {
    getNetwork: jest.fn(async () => ({ chainId: 10143n })),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      const tx = signed.find(t => t.hash === hash)!
      return {
        hash,
        from: tx.from,
        to: tx.to,
        status: 1,
        blockNumber: 0,
        index: 0,
      }
    }),
    getTransaction: jest.fn(async (hash: string) => {
      const tx = signed.find(t => t.hash === hash)!
      return {
        hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        chainId: tx.chainId,
        blockNumber: 0,
        index: 0,
      }
    }),
  }
  const wallet: EvmWalletHandle = {
    pool: bundle.pool,
    leaseManager: bundle.leaseManager,
    walletState: { ...bundle, inventory: undefined } as any,
    topicOperationJournal: bundle.topicOperationJournal,
    provider: provider as any,
    httpClient: {} as any,
    relayBaseUrl: 'http://localhost',
    cborNetwork: 'monad-testnet',
    forumBurnAddress: burn,
    forumChainId: 10143n,
  }
  http.mockImplementation(async (params: any) => {
    const parsed = validateFrame(params.data, defaultContext())
    if (parsed.kind !== 'parsed') throw new Error('Bad fixture request')
    const typed = parsed.typed!
    if (typed.type !== 41 && typed.type !== 42)
      throw new Error('Bad fixture family')
    const tx = Transaction.from(hexlify(typed.burnTx))
    const target =
      typed.type === 41
        ? topicBurnCommitment(typed.postFrame.frame).hash
        : typed.targetHash
    const payload = new Map<number, any>([
      [0, 'monad-testnet'],
      [1, params.data],
      [2, target],
      [3, getBytes(tx.hash!)],
      [4, getBytes(tx.from!)],
      [5, tx.data.slice(12, 14) === '01' ? 1 : 0],
      [6, tx.value],
      [7, 2],
      [8, 0n],
      [9, 0n],
      [10, 1n],
      [11, new Uint8Array(16)],
    ])
    return {
      data: encodeFrame(
        { typeId: 46, schemaVersion: 1, minReaderVersion: 1 },
        payload,
      ),
      headers: { 'content-type': 'application/cbor' },
    } as any
  })
  return { bundle, wallet, signer, provider, signed }
}
afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

const params = {
  topic: 'test',
  entries: [{ kind: 'post' as const, title: 'hello', message: 'world' }],
  direction: 'up' as const,
  burnAddress: burn,
  voteWeightWei: 7n,
  timestampMs: -1,
}
test('public post writes schema2 type10, preserves parent and exact authored timestamp', async () => {
  const f = await fixture()
  const parent = new Uint8Array(32).fill(2)
  const result = await new MonadTopicPostClient(f.wallet).submitTopicPost({
    ...params,
    parentPostHash: parent,
  })
  const parsed = validateFrame(result.postFrame, defaultContext())
  if (
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== 40 ||
    parsed.typed.schemaVersion !== 2
  )
    throw new Error('Expected canonical post')
  expect(parsed.typed.parentHash).toEqual(parent)
  expect(parsed.typed.content.authored).toEqual({
    seconds: -1n,
    nanoseconds: 999000000,
  })
  expect(result.status.state).toBe(2)
  expect(http.mock.calls[0][0]).toMatchObject({
    method: 'put',
    headers: {
      'Content-Type': 'application/cbor',
      'Accept': 'application/cbor',
    },
  })
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  await f.bundle.close()
})
test.each([0n, -1n, 1n << 63n])(
  'amount %s fails before lease/sign/send',
  async value => {
    const f = await fixture()
    await expect(
      new MonadTopicPostClient(f.wallet).submitTopicPost({
        ...params,
        voteWeightWei: value,
      }),
    ).rejects.toThrow()
    expect(f.signer).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
    expect(f.bundle.pool.records().every(r => r.status === 'available')).toBe(
      true,
    )
    await f.bundle.close()
  },
)
test('down post and bad parent fail before signing', async () => {
  const f = await fixture()
  const client = new MonadTopicPostClient(f.wallet)
  await expect(
    client.submitTopicPost({ ...params, direction: 'down' }),
  ).rejects.toThrow()
  await expect(
    client.submitTopicPost({ ...params, parentPostHash: new Uint8Array(31) }),
  ).rejects.toThrow()
  expect(f.signer).not.toHaveBeenCalled()
  await f.bundle.close()
})
test('transport loss retains same request and explicit resume settles without signing again', async () => {
  const f = await fixture()
  const client = new MonadTopicPostClient(f.wallet)
  const normal = http.getMockImplementation()!
  http.mockRejectedValueOnce(new Error('lost after send'))
  await expect(client.submitTopicPost(params)).rejects.toBeInstanceOf(
    MonadTopicPostAbandonedError,
  )
  const pending = f.bundle.topicOperationJournal.getAll()[0]
  expect(pending.writeFormat).toBe('forum-cbor')
  expect(f.bundle.pool.getRecord(pending.leaseIndex)!.status).toBe('in-use')
  http.mockImplementation(normal)
  await client.resumePendingOperations()
  expect(http.mock.calls[1][0]).toMatchObject({
    method: 'post',
    data: Uint8Array.from(pending.requestBytes),
  })
  expect(f.signer).toHaveBeenCalledTimes(1)
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  await f.bundle.close()
})

test('maximum admitted amount remains exact through signing and status', async () => {
  const f = await fixture()
  const value = (1n << 63n) - 1n
  const result = await new MonadTopicPostClient(f.wallet).submitTopicPost({
    ...params,
    voteWeightWei: value,
  })
  expect(result.status.value).toBe(value)
  expect(f.signed[0].value).toBe(value)
  await f.bundle.close()
})

test('pre-sign failure preserves existing unused-lease semantics with no journal or send', async () => {
  const f = await fixture()
  f.signer.mockImplementation(
    () =>
      ({
        buildAndSignCall: jest.fn(async () => {
          throw new Error('sign failed')
        }),
      } as any),
  )
  await expect(
    new MonadTopicPostClient(f.wallet).submitTopicPost(params),
  ).rejects.toThrow('sign failed')
  expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  expect(f.bundle.pool.getRecord(0)!.status).toBe('available')
  expect(http).not.toHaveBeenCalled()
  await f.bundle.close()
})

test('signs post with wallet.identity or params.authorIdentity when present', async () => {
  const f = await fixture()
  const identity = MonadIdentity.generate()
  const walletWithIdentity = {
    ...f.wallet,
    identity,
  }
  const result = await new MonadTopicPostClient(walletWithIdentity).submitTopicPost(params)
  const parsed = validateFrame(result.postFrame, defaultContext())
  expect(parsed.kind).toBe('parsed')
  const postTyped = parsed.typed as any
  expect(postTyped.from).toEqual({
    keyType: 1,
    keyBytes: new Uint8Array(identity.compressedPubKey),
  })
  expect(postTyped.signature).toBeInstanceOf(Uint8Array)
  expect(postTyped.signature.length).toBeGreaterThan(0)
  const verifiedAddress = verifyTopicPostAuthor(postTyped)
  expect(verifiedAddress).toBeDefined()
  expect(getAddress('0x' + toHex(verifiedAddress!))).toBe(identity.address.raw)
  await f.bundle.close()
})

test('quoteMonadTopicBurnGasReserve retries with bounded gas limit when signer throws CALL_EXCEPTION without gasLimit', async () => {
  const callException = Object.assign(new Error('missing revert data'), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
  })
  let callCount = 0
  const signer = {
    buildAndSignCall: jest.fn(async (_to: string, _value: bigint, _data: string, overrides?: any) => {
      callCount++
      if (callCount === 1 && overrides?.gasLimit === undefined) {
        throw callException
      }
      return {
        rawTx: '0x1234',
        txHash: '0xabcd',
        from: '0x1111111111111111111111111111111111111111',
        to: _to,
        value: _value,
        data: _data,
        gasLimit: overrides?.gasLimit ?? 21000n,
        maxFeePerGas: 2_000_000_000n,
        chainId: 10143n,
      }
    }),
  } as any

  const reserve = await quoteMonadTopicBurnGasReserve({
    signer,
    burnAddress: burn,
  })
  expect(callCount).toBe(2)
  expect(signer.buildAndSignCall).toHaveBeenLastCalledWith(
    burn,
    1n,
    expect.any(String),
    expect.objectContaining({ gasLimit: 31608n }),
  )
  // (31608n * 2000000000n * 5n) / 4n = 79020000000000n
  expect(reserve).toBe(79020000000000n)
})



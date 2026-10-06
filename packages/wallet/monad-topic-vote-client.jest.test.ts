import {
  MonadTopicVoteClient,
  MonadTopicVoteAbandonedError,
} from './monad-topic-vote-client'
import axios from 'axios'
import { Wallet, Transaction, getBytes, hexlify } from 'ethers'
import {
  encodeFrame,
  validateFrame,
  defaultContext,
  topicBurnCommitment,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/monad-wallet-bundle'
import { MonadHdKeyring } from './monad-hd-keyring'
import type { MonadWalletHandle } from './monad-wallet-handle'

jest.mock('axios')
const http = axios as jest.MockedFunction<typeof axios>
const mnemonic = 'test test test test test test test test test test test junk'
const burn = '0x000000000000000000000000000000000000dEaD'
async function fixture() {
  const bundle = createInMemoryMonadWalletBundle({ mnemonic })
  bundle.pool.ensureSize(2)
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
  const wallet: MonadWalletHandle = {
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
    if (typed.type !== 10 && typed.type !== 11)
      throw new Error('Bad fixture family')
    const tx = Transaction.from(hexlify(typed.burnTx))
    const target =
      typed.type === 10
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
        { typeId: 15, schemaVersion: 1, minReaderVersion: 1 },
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
  targetPayloadHash: new Uint8Array(32).fill(4),
  direction: 'down' as const,
  burnAddress: burn,
  voteWeightWei: 7n,
}
test.each(['up', 'down'] as const)(
  'canonical type11 %s vote requires exact confirmed status',
  async direction => {
    const f = await fixture()
    const result = await new MonadTopicVoteClient(f.wallet).castVote({
      ...params,
      direction,
    })
    expect(result.status.direction).toBe(direction === 'up' ? 1 : 0)
    expect(result.status.value).toBe(7n)
    expect(result.status.state).toBe(2)
    expect(http.mock.calls[0][0]).toMatchObject({
      method: 'put',
      url: 'http://localhost/message/monad/topics/vote',
      headers: {
        'Content-Type': 'application/cbor',
        'Accept': 'application/cbor',
      },
    })
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
    await f.bundle.close()
  },
)
test.each([0n, -1n, 1n << 63n])(
  'invalid amount %s fails before effects',
  async value => {
    const f = await fixture()
    await expect(
      new MonadTopicVoteClient(f.wallet).castVote({
        ...params,
        voteWeightWei: value,
      }),
    ).rejects.toThrow()
    expect(f.signer).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
    await f.bundle.close()
  },
)
test('204 shape-only success is uncertainty and same-byte replay performs no new signing', async () => {
  const f = await fixture()
  const normal = http.getMockImplementation()!
  http.mockResolvedValueOnce({
    data: new Uint8Array(),
    status: 204,
    headers: {},
  } as any)
  const client = new MonadTopicVoteClient(f.wallet)
  await expect(client.castVote(params)).rejects.toBeInstanceOf(
    MonadTopicVoteAbandonedError,
  )
  const retained = f.bundle.topicOperationJournal.getAll()[0]
  expect(retained.writeFormat).toBe('forum-cbor')
  http.mockImplementation(normal)
  await client.resumePendingOperations()
  expect(http.mock.calls[1][0]).toMatchObject({
    data: Uint8Array.from(retained.requestBytes),
  })
  expect(f.signer).toHaveBeenCalledTimes(1)
  await f.bundle.close()
})
test('unresolved pending vote blocks concurrent replacement before another signer call', async () => {
  const f = await fixture()
  http.mockRejectedValue(new Error('offline'))
  const client = new MonadTopicVoteClient(f.wallet)
  const results = await Promise.allSettled([
    client.castVote(params),
    client.castVote(params),
  ])
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
  expect(f.signer).toHaveBeenCalledTimes(1)
  expect(f.bundle.topicOperationJournal.getAll()).toHaveLength(1)
  await f.bundle.close()
})

test('HTTP rejection after send retains signed authority and does not infer prebroadcast failure', async () => {
  const f = await fixture()
  http.mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 400, data: 'rejected' },
  })
  await expect(
    new MonadTopicVoteClient(f.wallet).castVote(params),
  ).rejects.toBeInstanceOf(MonadTopicVoteAbandonedError)
  const rows = f.bundle.topicOperationJournal.getAll()
  expect(rows).toHaveLength(1)
  expect(f.bundle.pool.getRecord(rows[0].leaseIndex)!.status).toBe('in-use')
  expect(
    f.bundle.pool.getRecord(rows[0].leaseIndex)!.lifecycle!.spend!.rawTx,
  ).toBe(rows[0].rawTx)
  await f.bundle.close()
})

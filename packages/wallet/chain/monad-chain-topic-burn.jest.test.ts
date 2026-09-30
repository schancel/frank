/**
 * Ticket #273: a topic post or vote from an account that never sent a direct message failed with
 * "No available sub-account to lease", because only the DM path funded sub-accounts (#79) and the
 * topic clients leased from a pool nothing had funded.
 *
 * These tests drive `chain.topics.post` / `chain.topics.vote` end to end through the REAL pool,
 * lease manager, signer and topic clients over a small in-memory chain; only the relay's HTTP
 * (`axios`) and the RPC reads are faked. They fail on the pre-fix adapter (NoAvailableSubAccount)
 * and pin the money-safety properties of the fix: one funding transaction per burn account, no
 * spend when the RPC is down, and no second funding when a failed attempt left a usable account.
 */
import { JsonRpcProvider, Transaction, getBytes, sha256 } from 'ethers'
import axios from 'axios'

import { MonadIdentity } from '../monad-identity'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadTxSubmitter } from '../monad-account-tx'
import { MonadTopicPostRejectedError } from '../monad-topic-post-client'
import {
  MonadTopicPost,
  StoredMonadTopicPost,
  StoredMonadTopicVoteEntry,
} from '../topic_message_pb'
import {
  MonadChainConfig,
  MonadChainWalletHandle,
  TopicBurnPreparationError,
  createMonadChain,
} from './monad-chain'
import { DirectMessagePreparationProgress } from './active-chain'

jest.mock('axios')
const mockedAxios = axios as unknown as jest.Mock

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143
const WEIGHT = 1_000_000_000_000n
const GAS_PRICE = 2_000_000_000n
const GAS_LIMIT = 60_000n

const CONFIG: MonadChainConfig = {
  rpcUrl: 'http://127.0.0.1:1',
  relayBaseUrl: 'http://relay.test',
  networkTag: 'MONT',
  stampBurnAddress: BURN_ADDRESS,
  defaultStampValueWei: 10n * WEIGHT,
  defaultTopicVoteValueWei: WEIGHT,
  subAccountPoolSize: 3,
  walletStorageLocation: false,
}

const IDENTITY_KEY = '0x' + '11'.repeat(31) + '1a'

interface FakeChain {
  wallet: MonadChainWalletHandle
  pool: MonadSubAccountPool
  balances: Map<string, bigint>
  /** Every raw transaction handed to the RPC (funding transfers), in order. */
  rpcSubmissions: Transaction[]
  setRpcDown(down: boolean): void
  /** Fail the nonce read of any sub-account (the first RPC call of signing its burn). */
  setSigningDown(down: boolean): void
  mainAddress: string
}

function makeFakeChain(mainBalance = 10n ** 18n): FakeChain {
  const identity = MonadIdentity.fromPrivateKeyHex(IDENTITY_KEY)
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const rpcSubmissions: Transaction[] = []
  let rpcDown = false
  let signingDown = false
  const mainAddress = identity.address.raw
  balances.set(mainAddress.toLowerCase(), mainBalance)

  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  const guard = <T>(value: () => T) => {
    if (rpcDown) throw new Error('RPC unreachable (test)')
    return value()
  }
  const p = provider as unknown as Record<string, unknown>
  p.getBalance = async (address: string) =>
    guard(() => balances.get(address.toLowerCase()) ?? 0n)
  p.getTransactionCount = async (address: string) =>
    guard(() => {
      if (signingDown && address.toLowerCase() !== mainAddress.toLowerCase()) {
        throw new Error('RPC dropped while signing (test)')
      }
      return nonces.get(address.toLowerCase()) ?? 0
    })
  p.estimateGas = async () => guard(() => GAS_LIMIT)
  p.getFeeData = async () =>
    guard(() => ({
      gasPrice: GAS_PRICE,
      maxFeePerGas: GAS_PRICE,
      maxPriorityFeePerGas: 1_000_000_000n,
    }))

  const httpClient: MonadTxSubmitter = {
    submitRawTransaction: async rawTx => {
      if (rpcDown) throw new Error('RPC unreachable (test)')
      const tx = Transaction.from(rawTx)
      const from = tx.from!.toLowerCase()
      balances.set(from, (balances.get(from) ?? 0n) - tx.value - 21_000n)
      balances.set(
        tx.to!.toLowerCase(),
        (balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value,
      )
      nonces.set(from, tx.nonce + 1)
      rpcSubmissions.push(tx)
      return tx.hash!
    },
    getTransactionReceipt: async txHash => ({
      txHash,
      blockNumber: 1,
      blockHash: '0x' + '00'.repeat(32),
      status: 'success',
      gasUsed: 21_000n,
      effectiveGasPrice: 1n,
      logs: [],
    }),
  }

  const pool = new MonadSubAccountPool({
    keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
  })
  // Exactly what a fresh production wallet has after `createWallet`: derived, never funded.
  pool.ensureUnfundedSize(CONFIG.subAccountPoolSize)
  const wallet: MonadChainWalletHandle = {
    identity,
    pool,
    leaseManager: new SubAccountLeaseManager(pool),
    provider,
    httpClient,
    relayBaseUrl: CONFIG.relayBaseUrl,
  }
  return {
    wallet,
    pool,
    balances,
    rpcSubmissions,
    setRpcDown: down => {
      rpcDown = down
    },
    setSigningDown: down => {
      signingDown = down
    },
    mainAddress,
  }
}

function storedPostBytes(putBody: Uint8Array): Uint8Array {
  const sent = MonadTopicPost.deserializeBinary(putBody)
  const stored = new StoredMonadTopicPost()
  stored.setPost(sent)
  stored.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  stored.setTxHash(getBytes('0x' + '22'.repeat(32)))
  stored.setTimestamp(1_700_000_000_000)
  stored.setNetworkTag(new TextEncoder().encode('MONT'))
  return stored.serializeBinary()
}

function storedVoteBytes(): Uint8Array {
  const stored = new StoredMonadTopicVoteEntry()
  stored.setTargetPayloadHash(getBytes('0x' + 'ab'.repeat(32)))
  stored.setSenderAddress(getBytes('0x' + '11'.repeat(20)))
  stored.setTxHash(getBytes('0x' + '22'.repeat(32)))
  stored.setTimestamp(1_700_000_000_000)
  stored.setWeight(1)
  return stored.serializeBinary()
}

/** Relay behaviour for the `PUT`s the topic clients make; records each request body. */
function fakeRelay(behaviour: 'ok' | 'reject-500' = 'ok') {
  const puts: Array<{ url: string; body: Uint8Array }> = []
  mockedAxios.mockImplementation(async (req: Record<string, unknown>) => {
    const body = req.data as Uint8Array
    puts.push({ url: String(req.url), body })
    if (behaviour === 'reject-500') {
      throw Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: { status: 500, data: 'relay error (test)' },
      })
    }
    const isVote = String(req.url).endsWith('/vote')
    return {
      data: isVote ? storedVoteBytes() : storedPostBytes(body),
    }
  })
  ;(axios as unknown as { isAxiosError: unknown }).isAxiosError = (
    e: unknown,
  ) => (e as { isAxiosError?: boolean })?.isAxiosError === true
  return puts
}

const ENTRY = { kind: 'post' as const, title: 'T', message: 'hello' }

beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.mockReset()
})

describe('topics.post on a fresh wallet (no funded sub-accounts)', () => {
  it('funds exactly one burn account, then burns the vote weight from it', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay()
    const progress: string[] = []

    const result = await chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
      onPreparationProgress: (p: DirectMessagePreparationProgress) =>
        progress.push(p.stage),
    })

    // One main -> sub-account funding transfer of weight + fee reserve, sent before the burn.
    expect(fake.rpcSubmissions).toHaveLength(1)
    const funding = fake.rpcSubmissions[0]
    expect(funding.from!.toLowerCase()).toBe(fake.mainAddress.toLowerCase())
    expect(funding.value).toBeGreaterThan(WEIGHT)
    expect(progress[0]).toBe('checking')
    expect(progress).toContain('funding')
    expect(progress[progress.length - 1]).toBe('ready')

    // The relay got the burn, signed by the funded account, for exactly the vote weight.
    expect(puts).toHaveLength(1)
    const sent = MonadTopicPost.deserializeBinary(puts[0].body)
    const burn = Transaction.from(
      '0x' + Buffer.from(sent.getRawBurnTx_asU8()).toString('hex'),
    )
    expect(burn.to).toBe(BURN_ADDRESS)
    expect(burn.value).toBe(WEIGHT)
    expect(burn.from!.toLowerCase()).toBe(funding.to!.toLowerCase())
    expect(result.payloadDigest).toBe(
      sha256(sent.getEncryptedPayload_asU8()).slice(2),
    )

    // The funded account is consumed exactly once; nothing else was touched.
    const statuses = fake.pool.records().map(r => r.status)
    expect(statuses.filter(s => s === 'spent')).toHaveLength(1)
    expect(statuses.filter(s => s === 'unfunded')).toHaveLength(2)
  })

  it('a vote prepares its own burn account the same way', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay()

    await chain.topics.vote({
      wallet: fake.wallet,
      payloadDigest: 'ab'.repeat(32),
      direction: 'down',
      voteWeightWei: 2n * WEIGHT,
    })

    expect(fake.rpcSubmissions).toHaveLength(1)
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toContain('/message/monad/topics/vote')
    expect(fake.pool.records().filter(r => r.status === 'spent')).toHaveLength(
      1,
    )
  })

  it('spends nothing and leaves the pool untouched when the RPC is down, and a retry then funds exactly once', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay()
    const before = JSON.stringify(fake.pool.records())

    fake.setRpcDown(true)
    const failure = await chain.topics
      .post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [ENTRY],
        direction: 'up',
        voteWeightWei: WEIGHT,
      })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TopicBurnPreparationError)
    expect((failure as Error).message).toMatch(
      /RPC unreachable.*Nothing was sent.*safe to try again/s,
    )
    expect(fake.rpcSubmissions).toHaveLength(0)
    expect(puts).toHaveLength(0)
    expect(JSON.stringify(fake.pool.records())).toBe(before)

    fake.setRpcDown(false)
    await chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })
    expect(fake.rpcSubmissions).toHaveLength(1)
    expect(puts).toHaveLength(1)
  })

  it('a relay rejection retires the used account and the retry funds one new account (one burn per attempt, never two from one account)', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay('reject-500')

    await expect(
      chain.topics.post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [ENTRY],
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
    ).rejects.toBeInstanceOf(MonadTopicPostRejectedError)
    expect(
      fake.pool.records().filter(r => r.status === 'retired'),
    ).toHaveLength(1)

    puts.length = 0
    fakeRelay('ok')
    await chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })
    expect(fake.rpcSubmissions).toHaveLength(2)
    const [first, second] = fake.rpcSubmissions
    expect(second.to).not.toBe(first.to)
    expect(
      new Set(
        fake.pool
          .records()
          .filter(r => r.status !== 'unfunded')
          .map(r => r.index),
      ).size,
    ).toBe(2)
  })

  it('surfaces an insufficient main balance before moving any funds', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain(WEIGHT / 2n)
    fakeRelay()

    await expect(
      chain.topics.post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [ENTRY],
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
    ).rejects.toThrow(/Insufficient main account balance/)
    expect(fake.rpcSubmissions).toHaveLength(0)
    expect(fake.pool.records().every(r => r.status === 'unfunded')).toBe(true)
  })

  it('serializes a concurrent post, vote and post onto three distinct accounts and nonces', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay()
    // A scheduling gap between "account prepared" and "account leased" (the pool's own queue has
    // already released by then): only the wallet-level serialization keeps a concurrent operation
    // from preparing, finding that account still available, and leasing it too.
    const prepare = fake.pool.prepareBurnAccount.bind(fake.pool)
    fake.pool.prepareBurnAccount = async params => {
      const prepared = await prepare(params)
      await new Promise(resolve => setTimeout(resolve, 5))
      return prepared
    }

    await Promise.all([
      chain.topics.post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [ENTRY],
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
      chain.topics.vote({
        wallet: fake.wallet,
        payloadDigest: 'ab'.repeat(32),
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
      chain.topics.post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [{ ...ENTRY, title: 'second' }],
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
    ])
    expect(puts).toHaveLength(3)
    expect(fake.rpcSubmissions).toHaveLength(3)
    expect(fake.pool.records().filter(r => r.status === 'spent')).toHaveLength(
      3,
    )
    expect(fake.rpcSubmissions.map(tx => tx.nonce)).toEqual([0, 1, 2])
  })

  it('serializes concurrent posts so each burn uses its own prepared account', async () => {
    const chain = createMonadChain(CONFIG)
    const fake = makeFakeChain()
    const puts = fakeRelay()

    await Promise.all(
      [1, 2].map(n =>
        chain.topics.post({
          wallet: fake.wallet,
          topic: 'help',
          entries: [{ ...ENTRY, title: `post ${n}` }],
          direction: 'up',
          voteWeightWei: WEIGHT,
        }),
      ),
    )
    expect(fake.rpcSubmissions).toHaveLength(2)
    expect(puts).toHaveLength(2)
    const senders = puts.map(
      put =>
        Transaction.from(
          '0x' +
            Buffer.from(
              MonadTopicPost.deserializeBinary(put.body).getRawBurnTx_asU8(),
            ).toString('hex'),
        ).from,
    )
    expect(new Set(senders).size).toBe(2)
  })
})

describe('RPC failing between funding and signing (#273 review F1)', () => {
  const post = (chain: ReturnType<typeof createMonadChain>, fake: FakeChain) =>
    chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })
  const vote = (chain: ReturnType<typeof createMonadChain>, fake: FakeChain) =>
    chain.topics.vote({
      wallet: fake.wallet,
      payloadDigest: 'ab'.repeat(32),
      direction: 'up',
      voteWeightWei: WEIGHT,
    })

  it.each([
    ['post', post],
    ['vote', vote],
  ])(
    '%s: the funded account is kept, nothing is sent, and the retry funds nothing more',
    async (_name, act) => {
      const chain = createMonadChain(CONFIG)
      const fake = makeFakeChain()
      const puts = fakeRelay()

      fake.setSigningDown(true)
      const failure = await act(chain, fake).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(TopicBurnPreparationError)
      expect((failure as Error).message).toMatch(
        /RPC dropped while signing.*Nothing was sent.*safe to try again/s,
      )
      expect(puts).toHaveLength(0)
      // Funded once, and that account is still available (not retired, not leased).
      expect(fake.rpcSubmissions).toHaveLength(1)
      const statuses = fake.pool.records().map(r => r.status)
      expect(statuses.filter(s => s === 'available')).toHaveLength(1)
      expect(statuses).not.toContain('retired')
      expect(statuses).not.toContain('in-use')

      fake.setSigningDown(false)
      await act(chain, fake)
      expect(puts).toHaveLength(1)
      // Still one funding transaction across the failure and the retry.
      expect(fake.rpcSubmissions).toHaveLength(1)
    },
  )
})

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
import { JsonRpcProvider, Network, Transaction, Wallet, getBytes } from 'ethers'
import axios from 'axios'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultContext,
  topicBurnCommitment,
  validateFrame,
} from '@frank/codec'

import { MonadIdentity } from '../monad-identity'
import * as identityModule from '../monad-identity'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadTxSubmitter } from '../monad-account-tx'
import { MonadTopicPostRejectedError } from '../monad-topic-post-client'
import {
  MonadTopicPost,
  MonadTopicVote,
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
import { InMemoryTopicOperationJournal } from '../storage/topic-operation-journal'
import type { MonadWalletPersistenceBundle } from '../storage/monad-wallet-bundle'
import {
  InMemoryNativeTransactionAttemptStore,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  nativeTransactionAttemptKey,
  runNativeTransactionExclusive,
} from './chain-wallet'

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
  networkId: 'monad-test',
  chainId: CHAIN_ID,
  rpcChain: 'monad-testnet',
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

function makeFakeChain(
  mainBalance = 10n ** 18n,
  nativeWallet?: MonadChainWalletHandle,
): FakeChain {
  const identity =
    nativeWallet?.identity ?? MonadIdentity.fromPrivateKeyHex(IDENTITY_KEY)
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const rpcSubmissions: Transaction[] = []
  let rpcDown = false
  let signingDown = false
  const mainAddress = identity.address.raw
  balances.set(mainAddress.toLowerCase(), mainBalance)

  const provider =
    nativeWallet?.provider ??
    new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
  const guard = <T>(value: () => T) => {
    if (rpcDown) throw new Error('RPC unreachable (test)')
    return value()
  }
  const p = provider as unknown as Record<string, unknown>
  p.getNetwork = async () => Network.from(CHAIN_ID)
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

  const pool =
    nativeWallet?.pool ??
    new MonadSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
    })
  // Exactly what a fresh production wallet has after `createWallet`: derived, never funded.
  pool.ensureUnfundedSize(CONFIG.subAccountPoolSize)
  const leaseManager = new SubAccountLeaseManager(pool)
  const topicOperationJournal = new InMemoryTopicOperationJournal()
  const walletState = {
    pool,
    leaseManager,
    topicOperationJournal,
    runOperation: async (operation: (admission: never) => Promise<unknown>) =>
      operation(undefined as never),
  } as unknown as MonadWalletPersistenceBundle
  const wallet: MonadChainWalletHandle = nativeWallet ?? {
    chainKind: 'monad',
    networkId: CONFIG.networkId,
    getReceiveAddress: async () => identity.address,
    getBalance: () => provider.getBalance(mainAddress),
    sendNative: async () => {
      throw new Error('Native sends require the production wallet fixture')
    },
    close: async () => provider.destroy(),
    identity,
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: CONFIG.relayBaseUrl,
    topicWriteFormat: 'cbor',
    topicOperationJournal,
    walletState,
  }
  if (nativeWallet !== undefined) {
    Object.assign(nativeWallet.httpClient, httpClient)
    nativeWallet.provider.getTransactionReceipt = jest
      .fn()
      .mockResolvedValue(null)
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

function decodePostSubmission(putBody: Uint8Array) {
  const decoded = validateFrame(putBody, defaultContext({ operation: 'typed' }))
  if (decoded.kind !== 'parsed' || decoded.typed?.type !== 10) {
    throw new Error('expected a type-10 CBOR submission')
  }
  const post = decoded.typed.postFrame.typed
  if (post?.type !== 9) throw new Error('expected an embedded type-9 post')
  return { submission: decoded.typed, post }
}

function storedPostBytes(putBody: Uint8Array): Uint8Array {
  const { submission, post } = decodePostSubmission(putBody)
  const postFrame = submission.postFrame
  void post
  return postFrame.frame
}

function storedVoteBytes(target: Uint8Array): Uint8Array {
  const stored = new StoredMonadTopicVoteEntry()
  stored.setTargetPayloadHash(target)
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
    if (isVote) {
      const decoded = validateFrame(
        body,
        defaultContext({ operation: 'typed' }),
      )
      if (decoded.kind !== 'parsed' || decoded.typed?.type !== 11) {
        throw new Error('expected a type-11 CBOR vote')
      }
      return { data: storedVoteBytes(decoded.typed.targetHash) }
    }
    return { data: storedPostBytes(body) }
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
    const submitted = decodePostSubmission(puts[0].body)
    const burn = Transaction.from(
      '0x' + Buffer.from(submitted.submission.burnTx).toString('hex'),
    )
    expect(burn.to).toBe(BURN_ADDRESS)
    expect(burn.value).toBe(WEIGHT)
    expect(burn.from!.toLowerCase()).toBe(funding.to!.toLowerCase())
    expect(result.payloadDigest).toBe(
      Buffer.from(
        topicBurnCommitment(submitted.submission.postFrame.frame).hash,
      ).toString('hex'),
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
              decodePostSubmission(put.body).submission.burnTx,
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
        /RPC dropped while signing.*Nothing was sent.*funded account is kept.*safe to try again/s,
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

describe('main-account native attempt admission (#724)', () => {
  const recipient = { raw: '0x' + '42'.repeat(20) }
  const opened: MonadChainWalletHandle[] = []
  const directories: string[] = []

  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unmocked network request forbidden'))
  })

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(wallet => wallet.close()))
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true })
    jest.restoreAllMocks()
  })

  // A host-supplied attempt store, reopened from disk independently of wallet and pool objects.
  // This fixture has the same single-realm coordination boundary as the production interface.
  function diskStore(directory: string): NativeTransactionAttemptStore {
    const file = (key: string) => join(directory, encodeURIComponent(key))
    return {
      coordinationScope: 'single-realm',
      get: key =>
        existsSync(file(key))
          ? JSON.parse(readFileSync(file(key), 'utf8'))
          : undefined,
      put: (key, transaction) => {
        const descriptor = openSync(file(key), 'w')
        try {
          writeFileSync(descriptor, JSON.stringify(transaction))
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
      },
      delete: key => unlinkSync(file(key)),
    }
  }

  async function open(
    nativeAttemptStore: NativeTransactionAttemptStore = new InMemoryNativeTransactionAttemptStore(),
    walletStorageLocation: string | false = false,
  ) {
    const config = { ...CONFIG, nativeAttemptStore, walletStorageLocation }
    const chain = createMonadChain(config)
    const wallet = (await chain.createWallet({
      mnemonic: TEST_MNEMONIC,
    })) as MonadChainWalletHandle
    opened.push(wallet)
    const fake = makeFakeChain(10n ** 18n, wallet)
    const key = nativeTransactionAttemptKey({
      chainKind: 'monad',
      networkId: String(CHAIN_ID),
      address: fake.mainAddress.toLowerCase(),
    })
    const broadcast = wallet.httpClient.submitRawTransaction.bind(
      wallet.httpClient,
    )
    const rawAttempts: string[] = []
    let unknown = true
    wallet.httpClient.submitRawTransaction = async raw => {
      rawAttempts.push(raw)
      if (
        Transaction.from(raw).to?.toLowerCase() === recipient.raw &&
        unknown
      ) {
        throw new Error('Submission acknowledgment lost (test)')
      }
      return broadcast(raw)
    }
    return {
      ...fake,
      chain,
      key,
      nativeAttemptStore,
      rawAttempts,
      acknowledge: () => {
        unknown = false
      },
      send: () =>
        chain.nativeTransfers.send({ wallet, recipient, value: WEIGHT }),
    }
  }

  function relay() {
    const puts: Uint8Array[] = []
    mockedAxios.mockImplementation(async (req: Record<string, unknown>) => {
      const body = req.data as Uint8Array
      puts.push(body)
      if (String(req.url).endsWith('/vote')) {
        const vote = MonadTopicVote.deserializeBinary(body)
        return {
          data: storedVoteBytes(vote.getTargetPayloadHash_asU8()),
        }
      }
      const post = MonadTopicPost.deserializeBinary(body)
      const stored = new StoredMonadTopicPost()
      stored.setPost(post)
      return { data: stored.serializeBinary() }
    })
    return puts
  }

  const actions = [
    [
      'post',
      (
        chain: ReturnType<typeof createMonadChain>,
        wallet: MonadChainWalletHandle,
      ) =>
        chain.topics.post({
          wallet,
          topic: 'help',
          entries: [ENTRY],
          direction: 'up',
          voteWeightWei: WEIGHT,
        }),
    ],
    [
      'vote',
      (
        chain: ReturnType<typeof createMonadChain>,
        wallet: MonadChainWalletHandle,
      ) =>
        chain.topics.vote({
          wallet,
          payloadDigest: 'ab'.repeat(32),
          direction: 'up',
          voteWeightWei: WEIGHT,
        }),
    ],
  ] as const

  it.each(actions)(
    '%s holds before signing after a submission-unknown native transfer',
    async (_name, act) => {
      const f = await open()
      const puts = relay()
      const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
      await expect(f.send()).rejects.toBeInstanceOf(
        NativeTransactionSubmissionError,
      )
      const attempt = f.nativeAttemptStore.get(f.key)
      const poolBefore = f.pool.records()
      const result = await act(f.chain, f.wallet).catch(error => error)
      expect(f.rawAttempts).toHaveLength(1)
      expect(sign).toHaveBeenCalledTimes(1)
      expect(puts).toHaveLength(0)
      expect(result).toBeInstanceOf(TopicBurnPreparationError)
      expect(result.cause).toBeInstanceOf(NativeTransactionSubmissionError)
      expect(f.nativeAttemptStore.get(f.key)).toEqual(attempt)
      expect(f.wallet.getUnresolvedNativeTransaction!()).toEqual(attempt)
      expect(f.pool.records()).toEqual(poolBefore)
      await expect(f.wallet.getBalance()).resolves.toBe(10n ** 18n)
    },
  )

  it.each(['missing receipt', 'unavailable RPC'])(
    'reopening retains the hold with %s',
    async mode => {
      const directory = mkdtempSync(join(tmpdir(), 'frank-admission-'))
      directories.push(directory)
      const poolLocation = join(directory, 'pool')
      const identity = MonadIdentity.fromSeed({ mnemonic: TEST_MNEMONIC })
      mkdirSync(`${poolLocation}-${identity.address.raw.toLowerCase()}`)
      const original = await open(diskStore(directory), poolLocation)
      await expect(original.send()).rejects.toBeInstanceOf(
        NativeTransactionSubmissionError,
      )
      const attempt = original.nativeAttemptStore.get(original.key)
      const poolBefore = original.pool.records()
      await original.wallet.close()
      const restored = await open(diskStore(directory), poolLocation)
      expect(restored.nativeAttemptStore).not.toBe(original.nativeAttemptStore)
      expect(restored.pool.records()).toEqual(poolBefore)
      if (mode === 'unavailable RPC') {
        restored.wallet.provider.getTransactionReceipt = jest
          .fn()
          .mockRejectedValue(new Error('RPC unavailable'))
      }
      const puts = relay()
      for (const [, act] of actions) {
        await expect(
          act(restored.chain, restored.wallet),
        ).rejects.toBeInstanceOf(TopicBurnPreparationError)
      }
      expect(restored.rawAttempts).toHaveLength(0)
      expect(puts).toHaveLength(0)
      expect(original.nativeAttemptStore.get(original.key)).toEqual(attempt)
      expect(
        restored.wallet.provider.getTransactionReceipt,
      ).toHaveBeenCalledWith(attempt!.txHash)
    },
  )

  it('guards legacy DM inventory and its signing fee quote', async () => {
    const f = await open()
    fakeRelay('reject-500')
    const receiver = MonadIdentity.fromPrivateKeyHex(IDENTITY_KEY)
    jest.spyOn(identityModule, 'fetchMonadProfile').mockResolvedValue({
      address: receiver.address,
      pubKey: new Uint8Array(receiver.compressedPubKey),
    })
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const result = await f.chain.directMessages
      .send({
        wallet: f.wallet,
        recipient: receiver.address,
        items: [{ type: 'text', text: 'held inventory' }],
        stampValue: WEIGHT,
      })
      .catch(error => error)
    expect(sign).toHaveBeenCalledTimes(1)
    expect(f.rawAttempts).toHaveLength(1)
    expect(result).toBeInstanceOf(NativeTransactionSubmissionError)
    expect(f.pool.records().every(record => record.status === 'unfunded')).toBe(
      true,
    )
  })

  it('keeps the wallet creator admission store when used through another facade', async () => {
    const f = await open()
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    relay()
    const other = createMonadChain({
      ...CONFIG,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    await expect(actions[1][1](other, f.wallet)).rejects.toBeInstanceOf(
      TopicBurnPreparationError,
    )
    expect(f.rawAttempts).toHaveLength(1)
  })

  it('reads a coordinated attempt written after construction before admitting funding', async () => {
    const first = await open()
    const second = await open(first.nativeAttemptStore)
    const puts = relay()
    let entered!: () => void
    const entering = new Promise<void>(resolve => {
      entered = resolve
    })
    let release!: () => void
    const releasing = new Promise<void>(resolve => {
      release = resolve
    })
    const submit = first.wallet.httpClient.submitRawTransaction.bind(
      first.wallet.httpClient,
    )
    first.wallet.httpClient.submitRawTransaction = async raw => {
      entered()
      await releasing
      return submit(raw)
    }
    const sending = first.send().catch(error => error)
    await entering
    const voting = actions[1][1](second.chain, second.wallet).catch(
      error => error,
    )
    // An independent owner uses the same durable-attempt coordination key.
    let barrierEntered = false
    const barrier = runNativeTransactionExclusive(
      first.key,
      'single-realm',
      async () => {
        barrierEntered = true
      },
    )
    await new Promise(resolve => setImmediate(resolve))
    const passedBeforeRelease = barrierEntered
    const submissionsBeforeRelease = second.rawAttempts.length
    release()
    expect(await sending).toBeInstanceOf(NativeTransactionSubmissionError)
    const voteResult = await voting
    await barrier
    expect(passedBeforeRelease).toBe(false)
    expect(submissionsBeforeRelease).toBe(0)
    expect(voteResult).toBeInstanceOf(TopicBurnPreparationError)
    expect(second.rawAttempts).toHaveLength(0)
    expect(puts).toHaveLength(0)
    expect(second.wallet.provider.getTransactionReceipt).toHaveBeenCalledWith(
      first.nativeAttemptStore.get(first.key)!.txHash,
    )
  })

  it('retains exact retry bytes, then admits funding after acknowledgment', async () => {
    const f = await open()
    const puts = relay()
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const raw = f.rawAttempts[0]
    f.acknowledge()
    await f.wallet.retryUnresolvedNativeTransaction!()
    expect(f.rawAttempts).toEqual([raw, raw])
    await actions[0][1](f.chain, f.wallet)
    expect(f.rawAttempts).toHaveLength(3)
    expect(Transaction.from(f.rawAttempts[2]).nonce).toBe(1)
    expect(puts).toHaveLength(1)
  })

  it('holds concurrent native admission until funding releases the shared account lock', async () => {
    const funding = await open()
    const native = await open(funding.nativeAttemptStore)
    // Both owners observe the same chain nonce once the funding transaction is acknowledged.
    native.wallet.provider.getTransactionCount =
      funding.wallet.provider.getTransactionCount
    relay()
    let entered!: () => void
    const entering = new Promise<void>(resolve => {
      entered = resolve
    })
    let release!: () => void
    const releasing = new Promise<void>(resolve => {
      release = resolve
    })
    const prepare = funding.pool.prepareBurnAccount.bind(funding.pool)
    funding.pool.prepareBurnAccount = async params => {
      entered()
      await releasing
      return prepare(params)
    }
    const posting = actions[0][1](funding.chain, funding.wallet)
    await entering
    const sending = native.send().catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    const nativeSubmissionsBeforeRelease = native.rawAttempts.length
    release()
    await posting
    expect(await sending).toBeInstanceOf(NativeTransactionSubmissionError)
    expect(nativeSubmissionsBeforeRelease).toBe(0)
    expect(Transaction.from(funding.rawAttempts[0]).nonce).toBe(0)
    expect(Transaction.from(native.rawAttempts[0]).nonce).toBe(1)
  })

  it('conservatively holds preparation even for a funded account, then reuses it after resolution', async () => {
    const f = await open()
    relay()
    // Leave a confirmed funded account available by interrupting only its burn signing.
    f.setSigningDown(true)
    await expect(actions[0][1](f.chain, f.wallet)).rejects.toBeInstanceOf(
      TopicBurnPreparationError,
    )
    expect(f.pool.records().some(record => record.status === 'available')).toBe(
      true,
    )
    f.setSigningDown(false)
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const count = f.rawAttempts.length
    await expect(actions[1][1](f.chain, f.wallet)).rejects.toBeInstanceOf(
      TopicBurnPreparationError,
    )
    await f.wallet.resolveUnresolvedNativeTransaction!({
      transaction: f.nativeAttemptStore.get(f.key)!,
      outcome: 'not-submitted',
    })
    await actions[1][1](f.chain, f.wallet)
    expect(f.rawAttempts).toHaveLength(count)
  })

  it('admits funding after matching explicit native resolution', async () => {
    const f = await open()
    relay()
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    await expect(
      f.wallet.resolveUnresolvedNativeTransaction!({
        transaction: { txHash: 'wrong' },
        outcome: 'not-submitted',
      }),
    ).rejects.toThrow('does not match')
    await f.wallet.resolveUnresolvedNativeTransaction!({
      transaction: f.nativeAttemptStore.get(f.key)!,
      outcome: 'not-submitted',
    })
    await actions[1][1](f.chain, f.wallet)
    expect(f.rawAttempts).toHaveLength(2)
    expect(f.nativeAttemptStore.get(f.key)).toBeUndefined()
  })

  it('reconciles the exact restored receipt before funding', async () => {
    const original = await open()
    await expect(original.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const attempt = original.nativeAttemptStore.get(original.key)!
    await original.wallet.close()
    const restored = await open(original.nativeAttemptStore)
    restored.wallet.provider.getTransactionReceipt = jest
      .fn()
      .mockResolvedValue({ hash: attempt.txHash, status: 1 })
    relay()
    await actions[0][1](restored.chain, restored.wallet)
    expect(restored.wallet.provider.getTransactionReceipt).toHaveBeenCalledWith(
      attempt.txHash,
    )
    expect(restored.rawAttempts).toHaveLength(1)
    expect(restored.nativeAttemptStore.get(restored.key)).toBeUndefined()
  })
})

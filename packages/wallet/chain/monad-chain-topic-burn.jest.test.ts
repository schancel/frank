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
import {
  JsonRpcProvider,
  Network,
  Transaction,
  Wallet,
  getBytes,
  type Block,
  type TransactionResponse,
  type TransactionReceipt,
} from 'ethers'
import axios from 'axios'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultContext,
  topicBurnCommitment,
  contentHash,
  encodeForumReadFrame,
  type Encodable,
  validateFrame,
} from '@frank/codec'

import { MonadIdentity } from '../monad-identity'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadTxSubmitter } from '../monad-account-tx'
import { TopicPostOutcomeUnknownError } from './active-chain'
import { TopicBurnPreparationError, createEvmChain } from "./monad-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { DirectMessagePreparationProgress } from './active-chain'
import { InMemoryTopicOperationJournal } from '../storage/topic-operation-journal'
import type { MonadWalletPersistenceBundle } from '../storage/monad-wallet-bundle'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import {
  InMemoryNativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  nativeTransactionAttemptKey,
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

const CONFIG: EvmChainConfig = {
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
  wallet: EvmChainWalletHandle
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
  nativeWallet?: EvmChainWalletHandle,
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
  p.getTransactionReceipt = jest.fn(async (hash: string) => {
    const tx = observedBurns.get(hash.toLowerCase())
    return tx
      ? {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          status: 1,
          blockNumber: 1,
          index: 0,
        }
      : null
  })
  p.getTransaction = jest.fn(async (hash: string) => {
    const tx = observedBurns.get(hash.toLowerCase())
    return tx
      ? {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          chainId: tx.chainId,
          value: tx.value,
          data: tx.data,
          blockNumber: 1,
          index: 0,
        }
      : null
  })
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
  const wallet: EvmChainWalletHandle = nativeWallet ?? {
    family: 'evm',
    chainIdentifier: 'monad-testnet',
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
    cborNetwork: 'monad-testnet',
    forumBurnAddress: BURN_ADDRESS,
    forumChainId: BigInt(CHAIN_ID),
    topicOperationJournal,
    walletState,
  }
  if (nativeWallet !== undefined) {
    Object.assign(nativeWallet.httpClient, httpClient)
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

const observedBurns = new Map<string, Transaction>()
function confirmedStatus(body: Uint8Array): Uint8Array {
  const parsed = validateFrame(body, defaultContext())
  if (
    parsed.kind !== 'parsed' ||
    (parsed.typed?.type !== 10 && parsed.typed?.type !== 11)
  )
    throw new Error('Expected canonical operation')
  const operation = parsed.typed
  const tx = Transaction.from(
    '0x' + Buffer.from(operation.burnTx).toString('hex'),
  )
  observedBurns.set(tx.hash!.toLowerCase(), tx)
  const hash =
    operation.type === 10
      ? contentHash(operation.postFrame)
      : operation.targetHash
  return encodeForumReadFrame(
    15,
    new Map<number, Encodable>([
      [0, operation.network],
      [1, body],
      [2, hash],
      [3, getBytes(tx.hash!)],
      [4, getBytes(tx.from!)],
      [5, getBytes(tx.data)[5]],
      [6, tx.value],
      [7, 2],
      [8, 1],
      [9, 0],
      [10, 1],
      [11, new Uint8Array(16).fill(1)],
    ]),
  )
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
    return {
      data: confirmedStatus(body),
      headers: { 'content-type': 'application/cbor' },
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
  observedBurns.clear()
})

describe('topics.post on a fresh wallet (no funded sub-accounts)', () => {
  it('funds exactly one burn account, then burns the vote weight from it', async () => {
    const chain = createEvmChain(CONFIG)
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
    const chain = createEvmChain(CONFIG)
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
    const chain = createEvmChain(CONFIG)
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

  it('an uncertain relay response retains its account, then exact reconciliation permits a new funded account', async () => {
    const chain = createEvmChain(CONFIG)
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
    ).rejects.toBeInstanceOf(TopicPostOutcomeUnknownError)
    expect(fake.pool.records().filter(r => r.status === 'in-use')).toHaveLength(
      1,
    )

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
    const chain = createEvmChain(CONFIG)
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
    const chain = createEvmChain(CONFIG)
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
    const chain = createEvmChain(CONFIG)
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
  const post = (chain: ReturnType<typeof createEvmChain>, fake: FakeChain) =>
    chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })
  const vote = (chain: ReturnType<typeof createEvmChain>, fake: FakeChain) =>
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
      const chain = createEvmChain(CONFIG)
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

describe('durable EVM native operation ownership (#1230 P1)', () => {
  const recipient = { raw: '0x' + '42'.repeat(20) }
  const blockHash = '0x' + 'ab'.repeat(32)
  const opened: EvmChainWalletHandle[] = []
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

  function persistentLocation() {
    const directory = mkdtempSync(join(tmpdir(), 'frank-native-topic-cutover-'))
    directories.push(directory)
    const location = join(directory, 'wallet')
    const identity = MonadIdentity.fromSeed({ mnemonic: TEST_MNEMONIC })
    mkdirSync(`${location}-${identity.address.raw.toLowerCase()}`)
    return location
  }

  async function open(walletStorageLocation: string | false = false) {
    const oldStore = new InMemoryNativeTransactionAttemptStore()
    const chain = createEvmChain({
      ...CONFIG,
      walletStorageLocation,
      nativeAttemptStore: oldStore,
    })
    // Observe the real journal's public open boundary; the wallet deliberately keeps its
    // persistence bundle private. Opening delegates to the real implementation; no durable behavior is stubbed.
    let journal!: EvmNativeOperationJournal
    const realOpen = EvmNativeOperationJournal.prototype.Open
    const capture = jest
      .spyOn(EvmNativeOperationJournal.prototype, 'Open')
      .mockImplementationOnce(async function (this: EvmNativeOperationJournal) {
        journal = this
        await realOpen.call(this)
      })
    let wallet: EvmChainWalletHandle
    try {
      wallet = (await chain.createWallet({
        mnemonic: TEST_MNEMONIC,
      })) as EvmChainWalletHandle
    } finally {
      capture.mockRestore()
    }
    opened.push(wallet)
    const address = (await wallet.getReceiveAddress()).raw.toLowerCase()
    const rawAttempts: string[] = []
    let unknown = true
    let nonce = 0
    let included: Transaction | undefined
    const provider = wallet.provider
    jest
      .spyOn(provider, 'getBlock')
      .mockResolvedValue({ number: 1, hash: blockHash } as Block)
    jest
      .spyOn(provider, 'getBalance')
      .mockImplementation(async a =>
        String(a).toLowerCase() === address ? 10n ** 18n : 0n,
      )
    jest
      .spyOn(provider, 'getTransactionCount')
      .mockImplementation(async () => nonce)
    jest.spyOn(provider, 'getFeeData').mockResolvedValue({
      gasPrice: GAS_PRICE,
      maxFeePerGas: GAS_PRICE,
      maxPriorityFeePerGas: 1n,
    } as never)
    jest.spyOn(provider, 'estimateGas').mockResolvedValue(GAS_LIMIT)
    jest.spyOn(provider, 'getTransaction').mockImplementation(async hash =>
      included?.hash === hash
        ? (Object.assign(Transaction.from(included.serialized), {
            blockHash,
            blockNumber: 1,
            index: 0,
          }) as unknown as TransactionResponse)
        : null,
    )
    jest
      .spyOn(provider, 'getTransactionReceipt')
      .mockImplementation(async hash =>
        included?.hash === hash
          ? ({
              hash,
              from: included.from,
              to: included.to,
              blockHash,
              blockNumber: 1,
              index: 0,
              status: 1,
              gasPrice: GAS_PRICE,
              gasUsed: GAS_LIMIT,
            } as TransactionReceipt)
          : null,
      )
    jest
      .spyOn(provider, 'broadcastTransaction')
      .mockImplementation(async raw => {
        rawAttempts.push(raw)
        if (unknown) throw new Error('Submission acknowledgment lost (test)')
        const tx = Transaction.from(raw)
        nonce = tx.nonce + 1
        return { hash: tx.hash! } as TransactionResponse
      })
    return {
      chain,
      wallet,
      journal,
      address,
      oldStore,
      rawAttempts,
      acknowledge: () => {
        unknown = false
      },
      observe: (raw: string) => {
        included = Transaction.from(raw)
        nonce = included.nonce + 1
      },
      staleNonce: () => {
        nonce = 0
      },
      send: () =>
        chain.nativeTransfers.send({ wallet, recipient, value: WEIGHT }),
    }
  }

  it('checkpoints exact signed authorization and exposure in the durable owner without writing the old EVM hash-only store', async () => {
    const f = await open(persistentLocation())
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const rows = f.wallet.getNativeOperations!()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      kind: 'native',
      cancelled: false,
      recipient: recipient.raw,
      intendedValueWei: WEIGHT.toString(),
      binding: {
        chainIdentifier: 'monad-testnet',
        nativeChainId: String(CHAIN_ID),
      },
    })
    expect(row.members[0]).toMatchObject({
      exposed: true,
      signed: { rawTransaction: f.rawAttempts[0] },
    })
    const tx = Transaction.from(f.rawAttempts[0])
    expect(tx).toMatchObject({
      from: (await f.wallet.getReceiveAddress()).raw,
      to: recipient.raw,
      value: WEIGHT,
      nonce: 0,
      chainId: BigInt(CHAIN_ID),
    })
    expect(row.members[0]!.signed!.transactionHash).toBe(tx.hash)
    expect(f.journal.canSelect(f.address, 0)).toBe(false)
    expect(
      f.oldStore.get(
        nativeTransactionAttemptKey({
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          address: f.address,
        }),
      ),
    ).toBeUndefined()
  })

  it.each(['missing receipt', 'unavailable RPC'])(
    'real persistent reopen retains original bytes and claims with %s',
    async mode => {
      const location = persistentLocation()
      const first = await open(location)
      await expect(first.send()).rejects.toBeInstanceOf(
        NativeTransactionSubmissionError,
      )
      const original = first.wallet.getNativeOperations!()[0]!
      await first.wallet.close()
      const restored = await open(location)
      expect(restored.journal).not.toBe(first.journal)
      expect(restored.wallet.getNativeOperations!()).toEqual([original])
      if (mode === 'unavailable RPC')
        jest
          .spyOn(restored.wallet.provider, 'getTransactionReceipt')
          .mockRejectedValue(new Error('RPC unavailable'))
      const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
      await expect(restored.send()).rejects.toThrow(
        'Insufficient unreserved native funds',
      )
      expect(restored.rawAttempts).toEqual([])
      expect(sign).not.toHaveBeenCalled()
      expect(restored.journal.canSelect(restored.address, 0)).toBe(false)
      expect(
        restored.wallet.getNativeOperations!()[0]!.members[0]!.signed,
      ).toEqual(original.members[0]!.signed)
      restored.acknowledge()
      await restored.wallet.resumeNativeOperation!(original.operationId)
      expect(restored.rawAttempts).toEqual([
        original.members[0]!.signed!.rawTransaction,
      ])
      expect(sign).not.toHaveBeenCalled()
      expect(restored.wallet.getNativeOperations!()).toHaveLength(1)
    },
  )

  it('another facade cannot replace the creator wallet native-operation owner', async () => {
    const f = await open()
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const original = f.wallet.getNativeOperations!()[0]!
    const otherStore = new InMemoryNativeTransactionAttemptStore()
    const other = createEvmChain({
      ...CONFIG,
      nativeAttemptStore: otherStore,
    })
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    await expect(
      other.nativeTransfers.send({
        wallet: f.wallet,
        recipient,
        value: WEIGHT,
      }),
    ).rejects.toThrow('Insufficient unreserved native funds')
    expect(sign).not.toHaveBeenCalled()
    expect(f.rawAttempts).toHaveLength(1)
    expect(f.wallet.getNativeOperations!()[0]!.operationId).toBe(
      original.operationId,
    )
    expect(f.wallet.getNativeOperations!()[0]!.binding).toEqual(
      original.binding,
    )
  })

  it('repeated replay uses only the original exact signed bytes without fresh signing or payment', async () => {
    const f = await open()
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const original = f.wallet.getNativeOperations!()[0]!
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    f.acknowledge()
    await f.wallet.resumeNativeOperation!(original.operationId)
    await f.wallet.resumeNativeOperation!(original.operationId)
    expect(f.rawAttempts).toEqual(
      Array(3).fill(original.members[0]!.signed!.rawTransaction),
    )
    expect(sign).not.toHaveBeenCalled()
    expect(f.wallet.getNativeOperations!()).toHaveLength(1)
    expect(f.journal.canSelect(f.address, 0)).toBe(false)
  })

  it('matching inclusion retains signed history and its old pair across persistent reopen and a stale nonce rollback', async () => {
    const location = persistentLocation()
    const f = await open(location)
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const original = f.wallet.getNativeOperations!()[0]!
    f.observe(original.members[0]!.signed!.rawTransaction)
    // The native owner commits its observation before trying its separately composed sync callback.
    await f.wallet.resumeNativeOperation!(original.operationId).catch(error => {
      expect(error).toBeInstanceOf(NativeTransactionSubmissionError)
    })
    const observed = f.wallet.getNativeOperations!()[0]!
    expect(observed.members[0]!.observation).toMatchObject({
      state: 'included-success',
      transactionHash: original.members[0]!.signed!.transactionHash,
      blockHash,
    })
    expect(observed.members[0]!.signed).toEqual(original.members[0]!.signed)
    expect(observed.cancelled).toBe(false)
    expect(f.journal.canSelect(f.address, 0)).toBe(false)
    await f.wallet.close()
    const restored = await open(location)
    expect(restored.wallet.getNativeOperations!()).toEqual([observed])
    restored.staleNonce()
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    await expect(restored.send()).rejects.toThrow(
      'Insufficient unreserved native funds',
    )
    expect(sign).not.toHaveBeenCalled()
    expect(restored.rawAttempts).toHaveLength(0)
    expect(restored.wallet.getNativeOperations!()).toHaveLength(1)
    expect(restored.journal.canSelect(restored.address, 0)).toBe(false)
  })

  it('signed and exposed operations cannot be canceled or discarded as not submitted', async () => {
    const location = persistentLocation()
    const f = await open(location)
    await expect(f.send()).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError,
    )
    const original = f.wallet.getNativeOperations!()[0]!
    await expect(
      f.wallet.cancelUnsignedNativeOperation!(original.operationId),
    ).rejects.toThrow('conflict')
    expect(f.wallet.getNativeOperations!()).toEqual([original])
    await f.wallet.close()
    const restored = await open(location)
    expect(restored.wallet.getNativeOperations!()).toEqual([original])
    expect(restored.journal.canSelect(restored.address, 0)).toBe(false)
  })

  it('unsigned unexposed cancellation releases only its claim and durably retains public provenance', async () => {
    const location = persistentLocation()
    const f = await open(location)
    const unsignedTransaction = Transaction.from({
      type: 2,
      chainId: CHAIN_ID,
      nonce: 0,
      to: recipient.raw,
      value: WEIGHT,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: GAS_PRICE,
      maxPriorityFeePerGas: 1n,
    }).unsignedSerialized
    const original = await f.journal.prepare({
      kind: 'native',
      recipient: recipient.raw,
      intendedValueWei: WEIGHT.toString(),
      members: [
        {
          source: { kind: 'main', address: f.address },
          unsignedTransaction,
          dependencies: [],
        },
      ],
    })
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    expect(f.journal.canSelect(f.address, 0)).toBe(false)
    await f.wallet.cancelUnsignedNativeOperation!(original.operationId)
    const cancelled = { ...original, cancelled: true }
    expect(f.wallet.getNativeOperations!()).toEqual([cancelled])
    expect(f.journal.canSelect(f.address, 0)).toBe(true)
    expect(f.journal.sourceReferences()).toEqual([
      { kind: 'main', address: f.address },
    ])
    expect(sign).not.toHaveBeenCalled()
    expect(f.rawAttempts).toEqual([])
    await f.wallet.close()
    const restored = await open(location)
    expect(restored.wallet.getNativeOperations!()).toEqual([cancelled])
    expect(restored.journal.canSelect(restored.address, 0)).toBe(true)
    expect(restored.journal.sourceReferences()).toEqual([
      { kind: 'main', address: f.address },
    ])
  })

  // P1 does not claim cross-consumer exclusion. These obsolete hash-only/global-hold
  // assertions belong to the accepted P2 shared-input owner, including actual topic and DM paths.
  // "Topic post/vote exclude inputs reserved by an uncertain native operation" is covered below
  // for pool accounts (#1235): 'a pool account a native send spends from is not burned from'.
  it.todo(
    'P2: legacy/canonical DM selection and signing fee quotes share native claims',
  )
  it.todo(
    'P2: independently composed owners coordinate shared native and topic inputs',
  )
  it.todo(
    'P2: concurrent topic funding and native admission reserve exact account/nonce inputs',
  )
  it.todo(
    'P2: a funded topic account remains usable when disjoint native inputs are uncertain',
  )
})

/**
 * #1235 Stage R, at the topic boundary: the real composed wallet (`createEvmChain().createWallet`),
 * its real pool, lease manager, native operation journal and topic clients. Only the RPC and the
 * relay's HTTP are faked. The topic producer signs with no admission check, so the pool's
 * reservation is the only thing that keeps a burn off an account a native send is spending from.
 */
describe('a pool account a native send spends from is not burned from (#1235)', () => {
  const recipient = { raw: '0x' + '42'.repeat(20) }
  const blockHash = '0x' + 'ab'.repeat(32)
  const opened: EvmChainWalletHandle[] = []

  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unmocked network request forbidden'))
  })
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(wallet => wallet.close()))
    jest.restoreAllMocks()
  })

  /** Opens the wallet, funds pool account X through a topic post whose burn signing fails (the
   * production funding path: X is left `available` holding exactly one burn), then sends natively
   * from X. `pending`: the broadcast reply is lost and the node's pending view lacks the
   * transaction. `included`: it is mined and observed only by a fee estimate. */
  async function reserved(window: 'pending' | 'included') {
    const bundleModule = jest.requireActual(
      '../storage/monad-wallet-bundle',
    ) as typeof import('../storage/monad-wallet-bundle')
    const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
    let bundle!: MonadWalletPersistenceBundle
    jest
      .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
      .mockImplementation(async params => {
        bundle = await originalOpen(params)
        return bundle
      })
    const chain = createEvmChain({
      ...CONFIG,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = (await chain.createWallet({
      mnemonic: TEST_MNEMONIC,
    })) as EvmChainWalletHandle
    opened.push(wallet)
    const fake = makeFakeChain(10n ** 18n, wallet)
    const main = (await wallet.getReceiveAddress()).raw.toLowerCase()
    fake.balances.set(main, 10n ** 18n)
    const puts = fakeRelay()

    // Native RPC surface, layered over the fake chain's funding and burn reads.
    const provider = wallet.provider as unknown as Record<
      string,
      (...args: never[]) => Promise<unknown>
    >
    const burnTransaction = provider.getTransaction
    const burnReceipt = provider.getTransactionReceipt
    const fundingCount = provider.getTransactionCount
    const mined = new Map<string, Transaction>()
    const nativeNonces = new Map<string, number>()
    const nativeBroadcasts: Transaction[] = []
    let replyLost = false
    Object.assign(provider, {
      getBlock: async () => ({ hash: blockHash, number: 1 } as Block),
      getTransaction: async (hash: string) =>
        mined.has(hash)
          ? (Object.assign(Transaction.from(mined.get(hash)!.serialized), {
              blockHash,
              blockNumber: 1,
              index: 0,
            }) as unknown as TransactionResponse)
          : burnTransaction(hash as never),
      getTransactionReceipt: async (hash: string) =>
        mined.has(hash)
          ? ({
              hash,
              from: mined.get(hash)!.from,
              to: mined.get(hash)!.to,
              blockHash,
              blockNumber: 1,
              index: 0,
              status: 1,
              gasPrice: GAS_PRICE,
              gasUsed: GAS_LIMIT,
            } as TransactionReceipt)
          : burnReceipt(hash as never),
      getTransactionCount: async (address: string, ...rest: never[]) =>
        nativeNonces.get(address.toLowerCase()) ??
        fundingCount(address as never, ...rest),
      broadcastTransaction: async (raw: string) => {
        const tx = Transaction.from(raw)
        nativeBroadcasts.push(tx)
        if (replyLost) throw new Error('Submission acknowledgment lost (test)')
        const from = tx.from!.toLowerCase()
        mined.set(tx.hash!, tx)
        nativeNonces.set(from, tx.nonce + 1)
        fake.balances.set(
          from,
          (fake.balances.get(from) ?? 0n) - tx.value - GAS_LIMIT * GAS_PRICE,
        )
        return { hash: tx.hash! } as TransactionResponse
      },
    })

    const act = {
      post: () =>
        chain.topics.post({
          wallet,
          topic: 'help',
          entries: [ENTRY],
          direction: 'up',
          voteWeightWei: WEIGHT,
        }),
      vote: () =>
        chain.topics.vote({
          wallet,
          payloadDigest: 'ab'.repeat(32),
          direction: 'up',
          voteWeightWei: WEIGHT,
        }),
    }
    fake.setSigningDown(true)
    await expect(act.post()).rejects.toBeInstanceOf(TopicBurnPreparationError)
    fake.setSigningDown(false)
    expect(fake.rpcSubmissions).toHaveLength(1)
    const x = wallet.pool
      .records()
      .find(
        record =>
          record.address.toLowerCase() ===
          fake.rpcSubmissions[0].to!.toLowerCase(),
      )!
    expect(x.status).toBe('available')
    const xAddress = x.address.toLowerCase()

    // Main cannot pay, so the native send spends from X, leaving a residual.
    for (const address of new Set([main, fake.mainAddress.toLowerCase()]))
      fake.balances.set(address, 0n)
    replyLost = window === 'pending'
    const send = chain.nativeTransfers.send({
      wallet,
      recipient,
      value: WEIGHT / 2n,
    })
    if (window === 'pending')
      await expect(send).rejects.toBeInstanceOf(NativeTransactionSubmissionError)
    else await send
    replyLost = false
    for (const address of new Set([main, fake.mainAddress.toLowerCase()]))
      fake.balances.set(address, 10n ** 18n)
    if (window === 'included')
      await wallet.estimateLegacyFee!({ recipient, value: 1n })
    const member = wallet.getNativeOperations!()[0]!.members[0]!
    expect(member.source).toEqual({
      kind: 'spend',
      address: xAddress,
      index: x.index,
    })
    expect(member.observation.state).toBe(
      window === 'pending' ? 'missing' : 'included-success',
    )
    expect(nativeBroadcasts.map(tx => tx.from!.toLowerCase())).toEqual([
      xAddress,
    ])
    expect(wallet.pool.getRecord(x.index)!.status).toBe('available')
    const signers = jest.spyOn(Wallet.prototype, 'signTransaction')
    return {
      act,
      wallet,
      fake,
      puts,
      x,
      xAddress,
      nativeBroadcasts,
      /** Addresses that signed anything after the native send. */
      signedBy: () =>
        (signers.mock.instances as unknown as Wallet[]).map(signer =>
          signer.address.toLowerCase(),
        ),
      admission: () =>
        bundle.runLifetime(lifetime =>
          Promise.resolve(bundle.inputAdmission.inspect(lifetime)),
        ),
    }
  }

  const burnOf = (put: { url: string; body: Uint8Array }) => {
    const parsed = validateFrame(put.body, defaultContext())
    if (
      parsed.kind !== 'parsed' ||
      (parsed.typed?.type !== 10 && parsed.typed?.type !== 11)
    )
      throw new Error('expected a topic post or vote submission')
    return Transaction.from(
      '0x' + Buffer.from(parsed.typed.burnTx).toString('hex'),
    )
  }

  // Before the reservation, pending: preparation reused X and the burn was signed from it, at the
  // native member's own nonce. Included: preparation's reconciliation retired X before selection,
  // so the burn already used another account, but the retired row then conflicted with the native
  // claim and the admission reported `conflicting-authorization` for the whole wallet.
  it.each([
    ['pending', 'post', 'signs nothing from the reserved account'],
    ['pending', 'vote', 'signs nothing from the reserved account'],
    ['included', 'post', 'does not retire the reserved account or lock admission'],
    ['included', 'vote', 'does not retire the reserved account or lock admission'],
  ] as const)(
    '%s native send: a topic %s funds and burns from another account and %s',
    async (window, kind) => {
      const f = await reserved(window)
      expect(await f.admission()).toMatchObject({ status: 'ready' })

      await f.act[kind]()

      expect(f.puts).toHaveLength(1)
      const burn = burnOf(f.puts[0])
      expect(burn.value).toBe(WEIGHT)
      expect(burn.from!.toLowerCase()).not.toBe(f.xAddress)
      // A second funding transfer, to the account the burn was signed from.
      expect(f.fake.rpcSubmissions).toHaveLength(2)
      expect(f.fake.rpcSubmissions[1].to!.toLowerCase()).toBe(
        burn.from!.toLowerCase(),
      )
      expect(f.signedBy()).not.toContain(f.xAddress)
      expect(f.nativeBroadcasts).toHaveLength(1)
      // The reserved row is left to the native operation that spends from it.
      expect(f.wallet.pool.getRecord(f.x.index)!.status).toBe('available')
      expect(await f.admission()).toMatchObject({ status: 'ready' })
    },
  )
})

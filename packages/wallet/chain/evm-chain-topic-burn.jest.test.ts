import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
/**
 * Topic posts and votes use the composed wallet's shared signed transaction graph.
 * RPC and relay transport are simulated; custody, coin reservations, journals and recovery
 * remain real. Each Forum request carries one burn while owned change stays in the wallet graph.
 */
import {
  SigningKey,
  computeAddress,
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

import { MonadIdentity } from '../evm-identity'
import { MonadSubAccountPool } from '../evm-account-pool'
import { MonadTxSubmitter } from '../evm-account-tx'
import { TopicPostOutcomeUnknownError } from './active-chain'
import { createEvmChain } from "./evm-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { evmWalletInternals } from '../evm-wallet'
import type { MonadWalletPersistenceBundle } from '../storage/evm-wallet-bundle'
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
  networkId: 'monad-testnet',
  chainId: CHAIN_ID,
  rpcChain: 'monad-testnet',
  relayBaseUrl: 'http://relay.test',
  networkTag: 'MONT',
  stampBurnAddress: BURN_ADDRESS,
  resolveDefaultStamp: fixedStampDefault(10n * WEIGHT),
  defaultTopicVoteValueWei: WEIGHT,
  subAccountPoolSize: 3,
  // The stub node never mines on its own: a native send looks once and returns.
  nativeInclusionWaitMs: 0,
  walletStorageLocation: false,
}

interface FakeChain {
  wallet: EvmChainWalletHandle
  pool: MonadSubAccountPool
  balances: Map<string, bigint>
  /** Every raw transaction handed to RPC, including burn and owned redistribution. */
  rpcSubmissions: Transaction[]
  setRpcDown(down: boolean): void
  /** Fail RPC submission after the complete graph has been signed. */
  setSigningDown(down: boolean): void
  mainAddress: string
}

const helperWallets: EvmChainWalletHandle[] = []
afterEach(async () => { await Promise.all(helperWallets.splice(0).map(wallet => wallet.close())) })

async function makeFakeChain(
  mainBalance = 10n ** 18n,
  nativeWallet?: EvmChainWalletHandle,
): Promise<FakeChain> {
  if (!nativeWallet) {
    nativeWallet = await createEvmChain(CONFIG).createWallet({ mnemonic: TEST_MNEMONIC })
    helperWallets.push(nativeWallet)
  }
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const rpcSubmissions: Transaction[] = []
  let rpcDown = false
  let signingDown = false
  const mainAddress = (await nativeWallet.getReceiveAddress()).raw
  balances.set(mainAddress.toLowerCase(), mainBalance)

  const provider = nativeWallet.provider
  const guard = <T>(value: () => T) => {
    if (rpcDown) throw new Error('RPC unreachable (test)')
    return value()
  }
  const applied = new Set<string>()
  const apply = (tx: Transaction) => {
    if (applied.has(tx.hash!)) return
    const from = tx.from!.toLowerCase(), to = tx.to!.toLowerCase()
    const fee = tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!)
    if ((nonces.get(from) ?? 0) !== tx.nonce) throw new Error('Unexpected source nonce')
    if ((balances.get(from) ?? 0n) < tx.value + fee) throw new Error('Insufficient source balance')
    balances.set(from, balances.get(from)! - tx.value - fee)
    balances.set(to, (balances.get(to) ?? 0n) + tx.value)
    nonces.set(from, tx.nonce + 1)
    applied.add(tx.hash!)
  }
  const p = provider as unknown as Record<string, unknown>
  p.getTransactionReceipt = jest.fn(async (hash: string) => {
    const tx = observedBurns.get(hash.toLowerCase())
    if (tx) apply(tx)
    return tx
      ? {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          status: 1,
          gasUsed: tx.gasLimit,
          gasPrice: tx.gasPrice ?? tx.maxFeePerGas,
          blockHash: '0x' + 'ab'.repeat(32),
          blockNumber: 1,
          index: 0,
        }
      : null
  })
  p.getTransaction = jest.fn(async (hash: string) => {
    const tx = observedBurns.get(hash.toLowerCase())
    if (tx) apply(tx)
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
      if (rpcDown || signingDown) throw new Error('RPC submission unavailable (test)')
      const tx = Transaction.from(rawTx)
      apply(tx)
      observedBurns.set(tx.hash!.toLowerCase(), tx)
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

  const wallet = nativeWallet
  const pool = wallet.pool
  Object.assign(wallet.httpClient, httpClient)
  p.getBlockNumber = async () => guard(() => 100)
  p.getBlock = async () => guard(() => ({ number: 100, hash: '0x' + 'ab'.repeat(32) }))
  p.broadcastTransaction = async (raw: string) => {
    const hash = await httpClient.submitRawTransaction(raw)
    return { hash } as TransactionResponse
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
const burns = (_fake: FakeChain) => [...observedBurns.values()].filter(tx => tx.to === BURN_ADDRESS)
const signedGraph = (wallet: EvmChainWalletHandle) => wallet.getNativeOperations!()
  .flatMap(row => row.members.map(member => member.signed?.rawTransaction).filter((raw): raw is string => !!raw))
async function fundIndependentInputs(fake: FakeChain, count: number) {
  fake.balances.set(fake.mainAddress.toLowerCase(), 0n)
  for (const record of fake.pool.records().slice(0, count)) fake.balances.set(record.address.toLowerCase(), 10n ** 18n)
  await fake.wallet.refreshTransactionSetInventory!()
}


beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.mockReset()
  observedBurns.clear()
})

describe('topics.post on a fresh wallet (no funded sub-accounts)', () => {
  it('signs one burn and redistributes owned change through the shared graph', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()

    const result = await chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })

    // The complete shared graph has one external burn and separate wallet-owned change.
    expect(burns(fake)).toHaveLength(1)
    const change = fake.rpcSubmissions.filter(tx => tx.to !== BURN_ADDRESS)
    expect(change.length).toBeGreaterThan(0)
    expect(change.every(tx => tx.from!.toLowerCase() === fake.mainAddress.toLowerCase())).toBe(true)
    expect(fake.rpcSubmissions.every(tx => signedGraph(fake.wallet).includes(tx.serialized))).toBe(true)
    // The relay carries only the signed burn for exactly the vote weight.
    expect(puts).toHaveLength(1)
    const submitted = decodePostSubmission(puts[0].body)
    const burn = Transaction.from(
      '0x' + Buffer.from(submitted.submission.burnTx).toString('hex'),
    )
    expect(burn.to).toBe(BURN_ADDRESS)
    expect(burn.value).toBe(WEIGHT)
    expect(burn.from!.toLowerCase()).toBe(fake.mainAddress.toLowerCase())
    expect(burn.serialized).toBe(burns(fake)[0].serialized)
    expect(result.payloadDigest).toBe(
      Buffer.from(
        topicBurnCommitment(submitted.submission.postFrame.frame).hash,
      ).toString('hex'),
    )

    // The original main nonce is consumed; unused legacy pool rows remain unchanged.
    const statuses = fake.pool.records().map(r => r.status)
    expect(statuses).toEqual(['unfunded', 'unfunded', 'unfunded'])
    expect(evmWalletInternals(fake.wallet).coinList!.get(fake.mainAddress, 0)?.state).toBe('spent')
  })

  it('a vote uses the same graph and carries exactly one burn', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()

    await chain.topics.vote({
      wallet: fake.wallet,
      payloadDigest: 'ab'.repeat(32),
      direction: 'down',
      voteWeightWei: 2n * WEIGHT,
    })

    expect(burns(fake)).toHaveLength(1)
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toContain('/message/monad/topics/vote')
    expect(burns(fake)[0].value).toBe(2n * WEIGHT)
  })

  it('uses the configured intrinsic calldata floor without an estimateGas dependency', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()

    ;(fake.wallet.provider as any).estimateGas = jest.fn(async () => {
      throw Object.assign(new Error('missing revert data'), {
        code: 'CALL_EXCEPTION',
        action: 'estimateGas',
      })
    })

    const result = await chain.topics.post({
      wallet: fake.wallet,
      topic: 'help',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })

    expect(puts).toHaveLength(1)
    const submitted = decodePostSubmission(puts[0].body)
    const burn = Transaction.from(
      '0x' + Buffer.from(submitted.submission.burnTx).toString('hex'),
    )
    expect(burn.to).toBe(BURN_ADDRESS)
    expect(burn.value).toBe(WEIGHT)
    const tokens = getBytes(burn.data).reduce((sum, byte) => sum + (byte === 0 ? 1n : 4n), 0n)
    expect(burn.gasLimit).toBe(21_000n + 10n * tokens)
    expect(fake.wallet.provider.estimateGas).not.toHaveBeenCalled()
    expect(result.payloadDigest).toBe(
      Buffer.from(
        topicBurnCommitment(submitted.submission.postFrame.frame).hash,
      ).toString('hex'),
    )
  })

  it('spends nothing while RPC is down and completes one burn after recovery', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()
    const before = JSON.stringify(fake.pool.records())

    fake.setRpcDown(true)
    const pending = chain.topics.post({ wallet: fake.wallet, topic: 'help', entries: [ENTRY], direction: 'up', voteWeightWei: WEIGHT }).catch((error: unknown) => error)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(fake.rpcSubmissions).toHaveLength(0)
    expect(puts).toHaveLength(0)
    expect(signedGraph(fake.wallet)).toEqual([])
    expect(JSON.stringify(fake.pool.records())).toBe(before)
    fake.setRpcDown(false)
    expect(await pending).toBeInstanceOf(TopicPostOutcomeUnknownError)
    await fake.wallet.refreshTransactionSetInventory!()
    await chain.topics.reconcileOperations!({ wallet: fake.wallet })
    expect(burns(fake)).toHaveLength(1)
    expect(puts).toHaveLength(1)
  })

  it('an uncertain relay response replays the original graph before another burn uses owned change', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
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
    const original = signedGraph(fake.wallet)
    expect(original.length).toBeGreaterThan(0)
    const firstRequest = puts[0].body
    const retried = fakeRelay('ok')
    await chain.topics.reconcileOperations!({ wallet: fake.wallet })
    expect(retried).toHaveLength(1)
    expect(retried[0].body).toEqual(firstRequest)
    expect(signedGraph(fake.wallet)).toEqual(original)
    expect(burns(fake)).toHaveLength(1)
    await chain.topics.post({ wallet: fake.wallet, topic: 'help', entries: [{ ...ENTRY, title: 'next' }], direction: 'up', voteWeightWei: WEIGHT })
    expect(burns(fake)).toHaveLength(2)
    expect(burns(fake)[1].from).not.toBe(burns(fake)[0].from)
  })

  it('surfaces insufficient authoritative coin capacity before moving funds', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain(WEIGHT / 2n)
    fakeRelay()

    await expect(
      chain.topics.post({
        wallet: fake.wallet,
        topic: 'help',
        entries: [ENTRY],
        direction: 'up',
        voteWeightWei: WEIGHT,
      }),
    ).rejects.toThrow(/Insufficient available EVM coins/)
    expect(fake.rpcSubmissions).toHaveLength(0)
    expect(fake.pool.records().every(r => r.status === 'unfunded')).toBe(true)
  })

  it('reserves independent exact inputs for a concurrent post, vote and post', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()
    await fundIndependentInputs(fake, 3)
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
    expect(burns(fake)).toHaveLength(3)
    expect(new Set(burns(fake).map(tx => tx.from)).size).toBe(3)
    const pairs = fake.rpcSubmissions.map(tx => `${tx.from}:${tx.nonce}`)
    expect(new Set(pairs).size).toBe(pairs.length)

  })

  it('concurrent posts reserve separate funded accounts', async () => {
    const chain = createEvmChain(CONFIG)
    const fake = await makeFakeChain()
    const puts = fakeRelay()

    await fundIndependentInputs(fake, 2)
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
    expect(burns(fake)).toHaveLength(2)
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

describe('RPC failure after signing the complete Forum graph', () => {
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
    '%s: submission failure retains reservations and retries the original signed graph',
    async (_name, act) => {
      const chain = createEvmChain(CONFIG)
      const fake = await makeFakeChain()
      const puts = fakeRelay()

      fake.setSigningDown(true)
      await expect(act(chain, fake)).rejects.toThrow(/retained|pending/i)
      const exposed = puts.map(put => new Uint8Array(put.body))
      expect(fake.rpcSubmissions).toHaveLength(0)
      const original = signedGraph(fake.wallet)
      expect(original.length).toBeGreaterThan(0)
      const held = evmWalletInternals(fake.wallet).coinList!.all().filter(coin => coin.holder)
      expect(held.length).toBeGreaterThan(0)
      fake.setSigningDown(false)
      await chain.topics.reconcileOperations!({ wallet: fake.wallet })
      expect(puts.length).toBeGreaterThan(0)
      expect(new Set(puts.map(put => Buffer.from(put.body).toString('hex'))).size).toBe(1)
      if (exposed.length) expect(puts[puts.length - 1].body).toEqual(exposed[0])
      expect(burns(fake)).toHaveLength(1)
      expect(signedGraph(fake.wallet)).toEqual(original)
      expect([...observedBurns.values()].map(tx => tx.serialized).sort()).toEqual([...original].sort())

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
 * its coin list, native operation journal and topic clients. Only RPC and relay HTTP are faked.
 * A pending native account/nonce remains excluded; confirmed state permits its next nonce.
 */
describe('Forum respects native reservations and confirmed nonce transitions (#1235)', () => {
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

  /** Seed an owned pool deposit, then authorize a native spend from it. Observe either an
   * ambiguous submission or successful inclusion before selecting a Forum input. */
  async function reserved(window: 'pending' | 'included') {
    const bundleModule = jest.requireActual(
      '../storage/evm-wallet-bundle',
    ) as typeof import('../storage/evm-wallet-bundle')
    const originalOpen = bundleModule.openExistingPoolEvmWalletBundle
    let bundle!: MonadWalletPersistenceBundle
    jest
      .spyOn(bundleModule, 'openExistingPoolEvmWalletBundle')
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
    const fake = await makeFakeChain(10n ** 18n, wallet)
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
          (fake.balances.get(from) ?? 0n) - tx.value - tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!),
        )
        fake.balances.set(tx.to!.toLowerCase(), (fake.balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value)
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
    const x = wallet.pool.records()[0]!
    wallet.pool.setStatus(x.index, 'available')
    const xAddress = x.address.toLowerCase()
    fake.balances.set(xAddress, WEIGHT + 2n * GAS_LIMIT * GAS_PRICE)
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
      await wallet.reobserveNativeOperations!()
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
    expect(wallet.pool.getRecord(x.index)!.status).toBe(window === 'pending' ? 'available' : 'spent')
    const signers = jest.spyOn(SigningKey.prototype, 'sign')
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
        (signers.mock.instances as unknown as SigningKey[]).map(signer =>
          computeAddress(signer.publicKey).toLowerCase(),
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

  it.each([
    ['pending', 'post', 'signs nothing from the reserved account'],
    ['pending', 'vote', 'signs nothing from the reserved account'],
    ['included', 'post', 'uses only a confirmed successor nonce without locking admission'],
    ['included', 'vote', 'uses only a confirmed successor nonce without locking admission'],
  ] as const)(
    '%s native send: a topic %s preserves native input authority and %s',
    async (window, kind) => {
      const f = await reserved(window)
      expect(await f.admission()).toMatchObject({ status: 'ready' })

      const priorXBalance = f.fake.balances.get(f.xAddress)!
      await f.act[kind]()

      expect(f.puts).toHaveLength(1)
      const burn = burnOf(f.puts[0])
      expect(burn.value).toBe(burn.from!.toLowerCase() === f.xAddress
        ? priorXBalance - burn.gasLimit * (burn.gasPrice ?? burn.maxFeePerGas!)
        : WEIGHT)
      expect(burn.from!.toLowerCase() === f.xAddress && burn.nonce === 0).toBe(false)
      if (window === 'pending') expect(burn.from!.toLowerCase()).not.toBe(f.xAddress)
      expect(f.fake.rpcSubmissions.every(tx => tx.from!.toLowerCase() !== f.xAddress || tx.nonce > 0)).toBe(true)
      if (window === 'pending') expect(f.signedBy()).not.toContain(f.xAddress)
      expect(f.nativeBroadcasts.filter(tx => tx.from!.toLowerCase() === f.xAddress && tx.nonce === 0)).toHaveLength(1)
      // The reserved row is left to the native operation that spends from it.
      expect(f.wallet.pool.getRecord(f.x.index)!.status).toBe(window === 'pending' ? 'available' : 'spent')
      expect(await f.admission()).toMatchObject({ status: 'ready' })
    },
  )
})

describe('topics.post and topics.vote with received coin when mainAccount balance is 0', () => {
  const opened: EvmChainWalletHandle[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(wallet => wallet.close()))
    mockedAxios.mockReset()
    observedBurns.clear()
  })

  it('successfully prepares and burns from a received coin when mainAccount has 0 balance', async () => {
    const { deriveEvmStealthPrivateKey } = await import('../evm-stealth')
    const chain = createEvmChain({
      ...CONFIG,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = (await chain.createWallet({
      mnemonic: TEST_MNEMONIC,
    })) as EvmChainWalletHandle
    opened.push(wallet)
    const fake = await makeFakeChain(0n, wallet)
    const main = (await wallet.getReceiveAddress()).raw.toLowerCase()
    fake.balances.set(main, 0n)
    const puts = fakeRelay()

    // Generate and record a stealth payment (received coin in coinStore)
    const ephemeralWallet = new Wallet('0x' + '77'.repeat(32))
    const ephemeralPubKey = ephemeralWallet.signingKey.compressedPublicKey
    const derived = deriveEvmStealthPrivateKey({
      recipientSpendSecret: wallet.identity.toPrivateKeyHex(),
      ephemeralPubKey: getBytes(ephemeralPubKey),
    })
    const coinAddress = derived.stealthAddress.toLowerCase()

    await wallet.recordStealthPayment({
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      ephemeralPubKey: ephemeralPubKey.slice(2),
      transactions: [],
      amount: 10_000_000_000_000_000,
    })

    // Fund the received coin, while main remains 0
    fake.balances.set(coinAddress, 10n ** 18n)

    // Refresh received payments so the recorded coin is marked unspent with its on-chain balance
    await wallet.refreshReceivedPayments!()

    // Verify main balance is 0 and coin has balance
    expect(await wallet.provider.getBalance(main)).toBe(0n)
    expect(await wallet.provider.getBalance(coinAddress)).toBe(10n ** 18n)

    // The received input is reserved through the shared coin list before signing the graph.
    const prepare = jest.spyOn(evmWalletInternals(wallet).coinList!, 'reserveTransactionSetSources')
    const postResult = await chain.topics.post({
      wallet,
      topic: 'memes',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: WEIGHT,
    })

    expect(postResult.payloadDigest).toBeDefined()
    expect(fake.rpcSubmissions.length).toBeGreaterThanOrEqual(1)
    // The graph draws value from the received coin while main stays empty.
    const postFunding = fake.rpcSubmissions[0]
    expect(postFunding.from!.toLowerCase()).toBe(coinAddress)
    expect(prepare.mock.results.some(result => result.type === 'return' && result.value?.some((part: { coin: { account: string } }) => part.coin.account === coinAddress))).toBe(true)
    expect(burns(fake)).toHaveLength(1)
    expect(puts.length).toBeGreaterThanOrEqual(1)

    // 2. topics.vote also succeeds
    await chain.topics.vote({
      wallet,
      payloadDigest: postResult.payloadDigest,
      direction: 'up',
      voteWeightWei: WEIGHT,
    })
  })

  it('an account a funding run claimed under the main holder is let go once nothing it signed is undecided', async () => {
    const chain = createEvmChain({
      ...CONFIG,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = (await chain.createWallet({
      mnemonic: TEST_MNEMONIC,
    })) as EvmChainWalletHandle
    opened.push(wallet)
    await makeFakeChain(0n, wallet)
    const holder = `${wallet.identity.address.raw.toLowerCase()}:main-account`
    const funder = new Wallet('0x' + '78'.repeat(32)).address.toLowerCase()
    const busy = new Wallet('0x' + '79'.repeat(32)).address.toLowerCase()
    // As a topic burn's funding run leaves them: claimed under the main holder (not the main
    // or identity account), one with a transfer the chain has not decided yet.
    wallet.pool.restoreAccountClaim(holder, funder)
    wallet.pool.restoreAccountClaim(holder, busy)
    evmWalletInternals(wallet).unjournalledTransfers.set(busy, [
      { txHash: '0x' + 'ab'.repeat(32), nonce: 0 },
    ])
    await wallet.reobserveNativeOperations!()
    expect(wallet.pool.accountClaimedBy(funder)).toBeUndefined()
    expect(wallet.pool.accountClaimedBy(busy)).toBe(holder)
    evmWalletInternals(wallet).unjournalledTransfers.delete(busy)
    await wallet.reobserveNativeOperations!()
    expect(wallet.pool.accountClaimedBy(busy)).toBeUndefined()
  })

  it('aggregates multiple funding transactions when no single account covers the total required amount', async () => {
    const { deriveEvmStealthPrivateKey } = await import('../evm-stealth')
    const chain = createEvmChain({
      ...CONFIG,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = (await chain.createWallet({
      mnemonic: TEST_MNEMONIC,
    })) as EvmChainWalletHandle
    opened.push(wallet)
    const fake = await makeFakeChain(0n, wallet)
    const main = (await wallet.getReceiveAddress()).raw.toLowerCase()
    const puts = fakeRelay()

    // Two stealth coins
    const eph1 = new Wallet('0x' + '88'.repeat(32))
    const eph1Pub = eph1.signingKey.compressedPublicKey
    const derived1 = deriveEvmStealthPrivateKey({
      recipientSpendSecret: wallet.identity.toPrivateKeyHex(),
      ephemeralPubKey: getBytes(eph1Pub),
    })
    const coin1 = derived1.stealthAddress.toLowerCase()

    const eph2 = new Wallet('0x' + '99'.repeat(32))
    const eph2Pub = eph2.signingKey.compressedPublicKey
    const derived2 = deriveEvmStealthPrivateKey({
      recipientSpendSecret: wallet.identity.toPrivateKeyHex(),
      ephemeralPubKey: getBytes(eph2Pub),
    })
    const coin2 = derived2.stealthAddress.toLowerCase()

    await wallet.recordStealthPayment({
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      ephemeralPubKey: eph1Pub.slice(2),
      transactions: [],
      amount: 10_000_000_000_000_000,
    })
    await wallet.recordStealthPayment({
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      ephemeralPubKey: eph2Pub.slice(2),
      transactions: [],
      amount: 10_000_000_000_000_000,
    })

    // Each source is smaller than the intended burn before fees. Three sources together cover
    // their consolidation fees and the one burn; any uneconomic residual remains accounted for.
    const partBalance = 100_000_000_000_000n
    fake.balances.set(main, partBalance)
    fake.balances.set(coin1, partBalance)
    fake.balances.set(coin2, partBalance)

    await wallet.refreshReceivedPayments!()

    const postResult = await chain.topics.post({
      wallet,
      topic: 'memes',
      entries: [ENTRY],
      direction: 'up',
      voteWeightWei: 120_000_000_000_000n,
    })

    expect(postResult.payloadDigest).toBeDefined()
    // Multiple funding transactions were sent to aggregate into the burn sub-account!
    expect(fake.rpcSubmissions.length).toBeGreaterThanOrEqual(2)
    const funders = fake.rpcSubmissions.map(tx => tx.from!.toLowerCase())
    // More than one unique funder address contributed
    const uniqueFunders = new Set(funders)
    expect(uniqueFunders.size).toBeGreaterThanOrEqual(2)
    expect(burns(fake)).toHaveLength(1)
    const burn = burns(fake)[0]
    expect(burn.value).toBeGreaterThanOrEqual(120_000_000_000_000n)
    const fees = [...observedBurns.values()].reduce((sum, tx) => sum + tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!), 0n)
    const remainingOwned = [...fake.balances].filter(([address]) => address !== BURN_ADDRESS.toLowerCase()).reduce((sum, [, value]) => sum + value, 0n)
    expect(burn.value + fees + remainingOwned).toBe(3n * partBalance)
    expect(signedGraph(wallet)).toContain(burn.serialized)
    expect(puts.length).toBeGreaterThanOrEqual(1)
  })
})

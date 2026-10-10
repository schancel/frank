import {
  FetchRequest,
  JsonRpcProvider,
  Mnemonic,
  Network,
  SigningKey,
  Transaction,
  Wallet,
  getBytes,
  keccak256,
  type Block,
  type TransactionResponse,
  type TransactionReceipt,
} from 'ethers'
import { mkdtemp, mkdir, readdir, rm } from 'fs/promises'
import level from 'level'
import {
  cborMap,
  decodeCanonical,
  encodeFrame,
  fromHex,
  parseFrame,
  toHex,
} from '@frank/codec'
import { freezeCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import dmCorpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import {
  LevelCanonicalStampAttemptJournal,
  type CanonicalPreparedAttempt,
} from '../storage/stamp-attempt-journal'
import { CanonicalWalletBindingMismatchError } from '../storage/monad-wallet-bundle'
import { tmpdir } from 'os'
import { join } from 'path'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import { createChain } from './chain-factory'
import {
  canonicalMonadStampClient,
  createEvmChain,
  prepareMonadRevisionZeroExport,
} from "./monad-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import type { MonadRootBundle } from './active-chain'
import {
  InMemoryNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
} from './chain-wallet'
import * as materialModule from '../monad-wallet-material'
import * as providerModule from '../monad-provider'
import { MonadAccountTxSigner } from '../monad-account-tx'
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
import { LevelChangePoolStore } from '../storage/level-change-pool-store'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import {
  MonadSubAccountPool,
  SubAccountSpendRefusedError,
} from '../monad-account-pool'
import { NoAvailableSubAccountError } from '../monad-account-lease'
import { applyWalletSyncItem } from '../sync-dispatcher'
import type { WalletSyncItem } from '@frank/cashweb/types/messages'
import {
  EvmLegacyConsolidator,
  EvmNativeOperationPendingError,
} from './evm-legacy-consolidator'
import { LevelStampPaymentJournal } from '../storage/stamp-payment-journal'
import { MonadStampClient } from '../monad-stamp-client'
import * as topicModule from '../monad-topic-post-client'
import { MonadHttpClient } from '../monad-http'
import { createServer } from 'http'
import type { AddressInfo } from 'net'

jest.mock('../monad-account-tx', () => ({
  ...jest.requireActual('../monad-account-tx'),
  MonadAccountTxSigner: jest.fn(),
}))

const config: EvmChainConfig = {
  networkId: 'monad-test',
  chainId: 10143,
  rpcChain: 'monad-testnet',
  relayBaseUrl: 'http://127.0.0.1:1',
  networkTag: 'MONT',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  defaultStampValueWei: 1n,
  defaultTopicVoteValueWei: 1n,
  subAccountPoolSize: 2,
  walletStorageLocation: false,
}

function roots(index = 0): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: Uint8Array.from(
      Buffer.from(vectors.vectors[index].outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

// Independently derived with bitcore-lib-xpi HDPrivateKey.fromSeed(...).deriveChild(path),
// not the production ethers BIP32 implementation. Paths: auth/main 1'/0/0, pool 0'/0/0,
// change 0'/1/0, all below m/44'/60'. Inputs are frozen registry conformance vectors.
const expected = [
  {
    auth: '0xa3b72b83A95d61352E969D9f09DB4276295B4175',
    main: '0x4669EFf913A3c595CeA5FA92a600201e8e9E75d8',
    pool: '0x5b2657B0E7A5b7582beDc9Ae1724ba61BeC67724',
    change: '0x3912fB0cE7495829590C67914166ecB586D8F598',
    mainSecret:
      '0x4d7a4c4fcaa0c511f048652187aa56fb70fc74f1432636982200c58b0385c5d2',
  },
  {
    auth: '0x8dc3750A7789544eB239029B1Eb0EaaDdEbdfe9d',
    main: '0x44403a53EbB81056E865Fd706fE9B64E0B780390',
    pool: '0xBcF19B8C0495b9436c99d720b0A1fdcd587C3fB2',
    change: '0x7cf72fC477c43cA1aEAD13F92a3Ed0F32b33b280',
    mainSecret:
      '0xff688b36360c408d30d1c4856f64c1041fb1c9175a5e194fc3a0952243ebe25a',
  },
]

afterEach(() => jest.restoreAllMocks())

test.each([
  ['pool', LevelSubAccountPoolStore.prototype],
  ['change', LevelChangePoolStore.prototype],
  ['native', EvmNativeOperationJournal.prototype],
  ['canonical', LevelCanonicalStampAttemptJournal.prototype],
] as const)(
  'actual wallet publication waits for the %s owner; failure cannot publish, and opening starts no funding',
  async (_name, prototype) => {
    const dir = await mkdtemp(join(tmpdir(), 'frank-admission-publication-'))
    const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const paused = new Promise<void>(resolve => {
      release = resolve
    })
    const original = prototype.Open
    // Nothing funds as a side effect of opening: no pass ahead, no preparation, no signer.
    const ahead = jest.spyOn(
      MonadSubAccountPool.prototype,
      'fundStampInventoryAhead',
    )
    const prepare = jest.spyOn(
      MonadSubAccountPool.prototype,
      'prepareStampInventory',
    )
    jest.mocked(MonadAccountTxSigner).mockClear()
    const nothingFunded = () => {
      expect(ahead).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
      expect(jest.mocked(MonadAccountTxSigner)).not.toHaveBeenCalled()
    }
    const open = jest
      .spyOn(prototype, 'Open')
      .mockImplementationOnce(async function (this: typeof prototype) {
        entered()
        await paused
        return original.call(this)
      })
    let wallet:
      | Awaited<ReturnType<ReturnType<typeof createEvmChain>['createWallet']>>
      | undefined
    let published = false
    const opening = createEvmChain(cfg)
      .createWallet(roots())
      .then(value => {
        wallet = value
        published = true
        return value
      })
    try {
      await started
      expect(published).toBe(false)
      nothingFunded()
      release()
      await opening
      nothingFunded()
      await wallet!.close()
      wallet = undefined
      open.mockRejectedValueOnce(new Error('required owner failed'))
      await expect(createEvmChain(cfg).createWallet(roots())).rejects.toThrow(
        'required owner failed',
      )
      nothingFunded()
      open.mockRestore()
      wallet = await createEvmChain(cfg).createWallet(roots())
      nothingFunded()
    } finally {
      release()
      await opening.catch(() => undefined)
      await wallet?.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('rejects a second factory owner of the same EVM inventory until close', async () => {
  const firstChain = createEvmChain(config)
  const first = await firstChain.createWallet(roots())
  const otherChain = createEvmChain(config)
  await expect(otherChain.createWallet(roots())).rejects.toThrow('already open')
  await expect(
    otherChain.createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    }),
  ).rejects.toThrow('already open')
  await first.close()
  const next = await otherChain.createWallet({
    ...roots(),
    authentication: roots(1).authentication,
  })
  expect((await next.getReceiveAddress()).raw).toBe(expected[0].main)
  await next.close()
})

test('failed bundle validation wipes partial owned snapshots and preserves caller bytes', async () => {
  const input = roots()
  const snapshots: Uint8Array[] = []
  const copy = Uint8Array.from.bind(Uint8Array)
  jest
    .spyOn(Uint8Array, 'from')
    .mockImplementation((source: Iterable<unknown>) => {
      const bytes = copy(source as Iterable<number>)
      if (source === input.evm.bytes || source === input.authentication.bytes)
        snapshots.push(bytes)
      return bytes
    })
  await expect(
    createEvmChain(config).createWallet({
      ...input,
      messaging: undefined,
    } as unknown as MonadRootBundle),
  ).rejects.toThrow('messaging-encryption')
  expect(snapshots).toHaveLength(2)
  expect(snapshots.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  expect(input.evm.bytes.some(byte => byte !== 0)).toBe(true)
  expect(input.authentication.bytes.some(byte => byte !== 0)).toBe(true)
})

test.each([0, 1])(
  'factory consumes frozen vector %i without mnemonic derivation',
  async index => {
    const mnemonic = jest
      .spyOn(Mnemonic, 'fromPhrase')
      .mockImplementation(() => {
        throw new Error('BIP39 forbidden')
      })
    const chain = await createChain({ family: 'evm', config })
    const wallet = (await chain.createWallet(
      roots(index),
    )) as EvmChainWalletHandle
    try {
      expect(wallet.identity.address.raw).toBe(expected[index].auth)
      expect((await wallet.getReceiveAddress()).raw).toBe(expected[index].main)
      expect(wallet.pool.records()[0].address).toBe(expected[index].pool)
      expect(wallet.changePool!.peekNextChangeAddress().address).toBe(
        expected[index].change,
      )
      expect(mnemonic).not.toHaveBeenCalled()
      const balance = jest
        .spyOn(wallet.provider, 'getBalance')
        .mockResolvedValue(123n)
      expect(await chain.nativeTransfers.getBalance({ wallet })).toBe(123n)
      expect(balance).toHaveBeenCalledWith(expected[index].main)
    } finally {
      await wallet.close()
    }
  },
)

test.each(['evm', 'authentication', 'messaging'] as const)(
  'changing only %s changes only its role',
  async role => {
    const bundle = { ...roots(), [role]: roots(1)[role] }
    const wallet = (await createEvmChain(config).createWallet(
      bundle,
    )) as EvmChainWalletHandle
    try {
      expect(wallet.identity.address.raw).toBe(
        expected[role === 'authentication' ? 1 : 0].auth,
      )
      expect((await wallet.getReceiveAddress()).raw).toBe(
        expected[role === 'evm' ? 1 : 0].main,
      )
      expect(wallet.pool.records()[0].address).toBe(
        expected[role === 'evm' ? 1 : 0].pool,
      )
      expect(wallet.changePool!.peekNextChangeAddress().address).toBe(
        expected[role === 'evm' ? 1 : 0].change,
      )
    } finally {
      await wallet.close()
    }
  },
)

test.each([
  ['purpose', (r: MonadRootBundle) => ({ ...r, evm: r.authentication })],
  [
    'registry',
    (r: MonadRootBundle) => ({
      ...r,
      authentication: { ...r.authentication, registry: 'other' },
    }),
  ],
  [
    'short',
    (r: MonadRootBundle) => ({
      ...r,
      messaging: { ...r.messaging, bytes: new Uint8Array(31) },
    }),
  ],
  [
    'long',
    (r: MonadRootBundle) => ({
      ...r,
      evm: { ...r.evm, bytes: new Uint8Array(33) },
    }),
  ],
  [
    'missing messaging',
    (r: MonadRootBundle) => ({ evm: r.evm, authentication: r.authentication }),
  ],
  ['mixed mnemonic', (r: MonadRootBundle) => ({ ...r, mnemonic: 'invalid' })],
  ['mixed passphrase', (r: MonadRootBundle) => ({ ...r, passphrase: '' })],
  [
    'reused role secret',
    (r: MonadRootBundle) => ({
      ...r,
      authentication: { ...r.authentication, bytes: r.evm.bytes },
    }),
  ],
] as const)(
  'rejects %s before storage/provider/mnemonic effects',
  async (_name, mutate) => {
    const open = jest.spyOn(LevelSubAccountPoolStore.prototype, 'Open')
    const provider = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
    const mnemonic = jest.spyOn(Mnemonic, 'fromPhrase')
    const chain = createEvmChain({
      ...config,
      walletStorageLocation: 'must-not-open',
    })
    await expect(
      chain.createWallet(mutate(roots()) as MonadRootBundle),
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(mnemonic).not.toHaveBeenCalled()
  },
)

test('snapshots caller bytes, reuses exact bundles, rejects mismatches, wipes messaging on close', async () => {
  const original = materialModule.createMonadWalletMaterial
  const materials: materialModule.MonadWalletMaterial[] = []
  jest
    .spyOn(materialModule, 'createMonadWalletMaterial')
    .mockImplementation(input => {
      const material = original(input)
      materials.push(material)
      return material
    })
  const chain = createEvmChain(config)
  const input = roots()
  const pending = chain.createWallet(input)
  Object.values(input).forEach(root => root.bytes.fill(0))
  const wallet = await pending
  expect(materials[0].messagingRoot).toEqual(roots().messaging.bytes)
  expect(await chain.createWallet(roots())).toBe(wallet)
  expect(materials[1].messagingRoot!.every(byte => byte === 0)).toBe(true)
  for (const role of ['evm', 'messaging'] as const) {
    await expect(
      chain.createWallet({ ...roots(), [role]: roots(1)[role] }),
    ).rejects.toThrow('cached identity')
    expect(
      materials[materials.length - 1].messagingRoot!.every(byte => byte === 0),
    ).toBe(true)
  }
  await expect(
    chain.createWallet({ ...roots(), authentication: roots(1).authentication }),
  ).rejects.toThrow('already open')
  await wallet.close()
  expect(materials[0].messagingRoot!.every(byte => byte === 0)).toBe(true)
  await expect(wallet.getReceiveAddress()).rejects.toThrow('closed')
  await expect(wallet.getBalance()).rejects.toThrow('closed')
  await expect(
    wallet.sendNative({ recipient: { raw: expected[0].main }, value: 1n }),
  ).rejects.toThrow('closed')
  await expect(
    chain.directMessages.fetchSince({ wallet, sinceMs: 0 }),
  ).rejects.toThrow('closed')
  const reopened = await chain.createWallet(roots())
  expect(reopened).not.toBe(wallet)
  expect((await reopened.getReceiveAddress()).raw).toBe(expected[0].main)
  await reopened.close()
})

test('typed DM entrypoints stay pending without a verified directory, before plaintext, payment, or network access', async () => {
  const chain = createEvmChain(config)
  const wallet = await chain.createWallet(roots())
  const items: import('@frank/cashweb/types/messages').MessageItem[] = []
  const plaintextRead = jest.fn(() => {
    throw new Error('plaintext touched')
  })
  Object.defineProperty(items, 'map', { get: plaintextRead })
  const resume = jest.spyOn(MonadStampClient.prototype, 'resumePendingAttempts')
  const network = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('network touched'))
  const signer = MonadAccountTxSigner as jest.MockedClass<
    typeof MonadAccountTxSigner
  >
  signer.mockClear()
  await expect(
    chain.directMessages.send({
      wallet,
      recipient: { raw: expected[1].auth },
      items,
    }),
  ).rejects.toMatchObject({ name: 'CanonicalMessagingPendingError' })
  await expect(
    chain.directMessages.fetchSince({ wallet, sinceMs: 0 }),
  ).rejects.toMatchObject({ name: 'CanonicalMessagingPendingError' })
  await expect(
    chain.directMessages.reconcileAttempts({ wallet, payloadDigests: [] }),
  ).rejects.toMatchObject({ name: 'CanonicalMessagingPendingError' })
  await expect(
    chain.directMessages.unattributedAttempts({ wallet, knownDigests: [] }),
  ).rejects.toMatchObject({ name: 'CanonicalMessagingPendingError' })
  await expect(
    chain.directMessages.listRecoveredStampPayments({ wallet }),
  ).rejects.toThrow('legacy stamp-payment journal')
  await expect(
    chain.directMessages.sweepRecoveredStampPayment({
      wallet,
      payloadDigest: '00',
      childIndex: 0,
      destination: { raw: expected[0].main },
    }),
  ).rejects.toThrow('legacy stamp-payment journal')
  expect(plaintextRead).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
  expect(signer).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  await wallet.close()
})

function mockNativeRpc(
  wallet: EvmChainWalletHandle,
  initial: Record<string, bigint>,
  initialNonces: Record<string, number> = {},
  // What an earlier session's mock already mined: the chain does not forget across a reopen.
  mined: {
    transactions?: Map<string, TransactionResponse>
    receipts?: Map<string, TransactionReceipt>
  } = {},
) {
  const balances = new Map(
    Object.entries(initial).map(([key, value]) => [key.toLowerCase(), value]),
  )
  const nonces = new Map<string, number>(
    Object.entries(initialNonces).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  )
  const transactions = new Map<string, TransactionResponse>(mined.transactions)
  const receipts = new Map<string, TransactionReceipt>(mined.receipts)
  const blockHash = '0x' + 'ab'.repeat(32)
  jest
    .spyOn(wallet.provider, 'getBlock')
    .mockResolvedValue({ hash: blockHash, number: 1 } as Block)
  jest
    .spyOn(wallet.provider, 'getBalance')
    .mockImplementation(async a => balances.get(String(a).toLowerCase()) ?? 0n)
  jest
    .spyOn(wallet.provider, 'getTransactionCount')
    .mockImplementation(async a => nonces.get(String(a).toLowerCase()) ?? 0)
  jest.spyOn(wallet.provider, 'getFeeData').mockResolvedValue({
    gasPrice: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as never)
  jest.spyOn(wallet.provider, 'estimateGas').mockResolvedValue(21000n)
  jest
    .spyOn(wallet.provider, 'getTransaction')
    .mockImplementation(async hash => transactions.get(hash) ?? null)
  jest
    .spyOn(wallet.provider, 'getTransactionReceipt')
    .mockImplementation(async hash => receipts.get(hash) ?? null)
  const broadcast = jest
    .spyOn(wallet.provider, 'broadcastTransaction')
    .mockImplementation(async raw => {
      const tx = Transaction.from(raw)
      const from = tx.from!.toLowerCase()
      nonces.set(from, tx.nonce + 1)
      balances.set(from, (balances.get(from) ?? 0n) - tx.value - 21000n)
      transactions.set(
        tx.hash!,
        Object.assign(tx, {
          blockHash,
          blockNumber: 1,
          index: 0,
        }) as unknown as TransactionResponse,
      )
      receipts.set(tx.hash!, {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        blockHash,
        blockNumber: 1,
        index: 0,
        status: 1,
        gasPrice: 1n,
        gasUsed: 21000n,
      } as TransactionReceipt)
      return { hash: keccak256(raw) } as TransactionResponse
    })
  return { broadcast, balances, nonces, transactions, receipts }
}

test('native signed bytes survive restart and authentication changes without an EVM hash-only writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-native-composition-'))
  const store = new InMemoryNativeTransactionAttemptStore()
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: store,
  }
  const first = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  let restored: EvmChainWalletHandle | undefined
  try {
    const rpc = mockNativeRpc(first, { [expected[0].main]: 100000n })
    rpc.broadcast.mockRejectedValueOnce(new Error('reply lost'))
    await expect(
      first.sendNative({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('unknown')
    const row = first.getNativeOperations!()[0]!
    expect(Transaction.from(row.members[0]!.signed!.rawTransaction).from).toBe(
      expected[0].main,
    )
    expect(
      store.get(
        nativeTransactionAttemptKey({
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          address: expected[0].main.toLowerCase(),
        }),
      ),
    ).toBeUndefined()
    await first.close()
    restored = (await createEvmChain(cfg).createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    })) as EvmChainWalletHandle
    const next = mockNativeRpc(restored, { [expected[0].main]: 100000n })
    const tx = await restored.retryUnresolvedNativeTransaction!()
    expect(tx.txHash).toBe(row.members[0]!.signed!.transactionHash)
    expect(next.broadcast).toHaveBeenCalledWith(
      row.members[0]!.signed!.rawTransaction,
    )
    expect(restored.getNativeOperations!()).toHaveLength(1)
  } finally {
    await restored?.close()
    await first.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test.each([false, true])(
  'authentication signs relay challenges while topic funding uses EVM main (another facade: %s)',
  async anotherFacade => {
    const provider = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
    const chain = createEvmChain(config)
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    try {
      const auth = provider.mock.calls[0][0].relayAuth!
      expect(auth.customer).toBe(expected[0].auth)
      const digest = new Uint8Array(32).fill(9)
      expect(await auth.signDigest(digest)).toEqual(
        wallet.identity.signHash(Buffer.from(digest)),
      )
      const prepare = jest
        .spyOn(wallet.pool, 'prepareBurnAccount')
        .mockResolvedValue({ index: 0, fundingTxHashes: [] })
      jest
        .spyOn(topicModule, 'quoteMonadTopicBurnGasReserve')
        .mockResolvedValue(1n)
      jest
        .spyOn(topicModule.MonadTopicPostClient.prototype, 'submitTopicPost')
        .mockResolvedValue({ payloadHashHex: 'aa' } as Awaited<
          ReturnType<topicModule.MonadTopicPostClient['submitTopicPost']>
        >)
      await expect(
        (anotherFacade ? createEvmChain(config) : chain).topics.post({
          wallet,
          topic: 'fixture',
          entries: [],
          direction: 'up',
          voteWeightWei: 1n,
        }),
      ).resolves.toEqual({ payloadDigest: 'aa' })
      expect(prepare).toHaveBeenCalled()
      expect(MonadAccountTxSigner).toHaveBeenLastCalledWith(
        expect.objectContaining({ privateKey: expected[0].mainSecret }),
      )
    } finally {
      await wallet.close()
    }
  },
)

test.each([false, true])(
  'close drains an in-flight native operation and rejects further work (demo: %s)',
  async demo => {
    if (demo)
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          kind: 'frank-simulated-ledger-v1',
          amountWei: '1000000000000000000',
          token: 'ab'.repeat(32),
        }),
      } as Response)
    const chain = createEvmChain({
      ...config,
      ...(demo
        ? {
            networkId: 'monad-testnet',
            fakeDemo: { enabled: true, controlUrl: 'http://127.0.0.1:8545' },
          }
        : {}),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = await chain.createWallet(roots())
    const destroyHttp = jest.spyOn(MonadHttpClient.prototype, 'destroy')
    const rpc = mockNativeRpc(wallet as EvmChainWalletHandle, {
      [expected[0].main]: 100000n,
    })
    let signedHash = ''
    let release!: () => void
    let started!: () => void
    const signing = new Promise<void>(resolve => (started = resolve))
    const wait = new Promise<void>(resolve => (release = resolve))
    const send = wallet.sendNative({
      recipient: { raw: expected[1].main },
      value: 1n,
      onSigned: async signed => {
        signedHash = signed.txHash
        started()
        await wait
      },
    })
    await signing
    const close = wallet.close()
    await expect(chain.createWallet(roots())).rejects.toThrow('closed')
    await expect(
      wallet.sendNative({ recipient: { raw: expected[1].main }, value: 1n }),
    ).rejects.toThrow('closed')
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(destroyHttp).not.toHaveBeenCalled()
    release()
    await expect(send).resolves.toEqual({ txHash: signedHash })
    await close
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    expect(destroyHttp).toHaveBeenCalledTimes(1)
  },
)

test('cached callers serialize signing through the same durable native owner', async () => {
  const chain = createEvmChain({
    ...config,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const [first, second] = await Promise.all([
    chain.createWallet(roots()),
    chain.createWallet(roots()),
  ])
  expect(first).toBe(second)
  const rpc = mockNativeRpc(first as EvmChainWalletHandle, {
    [expected[0].main]: 100000n,
  })
  jest
    .spyOn(chain.directMessages, 'send')
    .mockResolvedValue({ payloadDigest: 'aa' } as never)
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => {
    started = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const a = first.sendNative({
      recipient: { raw: expected[1].main },
      value: 1n,
      onSigned: async () => {
        started()
        await gate
      },
    })
    await entered
    const b = second.sendNative({
      recipient: { raw: expected[1].main },
      value: 2n,
    })
    await Promise.resolve()
    expect(first.getNativeOperations!()).toHaveLength(1)
    expect(rpc.broadcast).not.toHaveBeenCalled()
    release()
    await Promise.all([a, b])
    expect(first.getNativeOperations!()).toHaveLength(2)
    expect(
      rpc.broadcast.mock.calls.map(([raw]) => Transaction.from(raw).nonce),
    ).toEqual([0, 1])
  } finally {
    release?.()
    await first.close()
  }
})

test.each(['sendNative', 'sendLegacy'] as const)(
  'snapshots %s authorization before the public wallet queue',
  async method => {
    const chain = createEvmChain(config)
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    const rpc = mockNativeRpc(wallet, { [expected[0].main]: 500000n })
    jest
      .spyOn(chain.directMessages, 'send')
      .mockResolvedValue({ payloadDigest: 'aa' } as never)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const wait = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      const first = wallet.sendNative({
        recipient: { raw: expected[1].main },
        value: 1000n,
        onSigned: async () => {
          entered()
          await wait
        },
      })
      await started
      const params = { recipient: { raw: expected[1].main }, value: 100000n }
      const second = wallet[method]!(params)
      params.recipient.raw = expected[1].auth
      params.value = 150000n
      release()
      await Promise.all([first, second])
      const tx = Transaction.from(rpc.broadcast.mock.calls[1]![0])
      expect(tx.to).toBe(expected[1].main)
      expect(tx.value).toBe(100000n)
      const row = wallet.getNativeOperations!()[1]!
      expect(row.recipient).toBe(expected[1].main.toLowerCase())
      expect(row.intendedValueWei).toBe('100000')
    } finally {
      release?.()
      await wallet.close()
    }
  },
)

test.each(['main', 'identity'] as const)(
  'retains the pending %s funding admission hold through timeout and reopen',
  async origin => {
    const dir = await mkdtemp(join(tmpdir(), 'frank-native-funding-hold-'))
    const cfg = {
      ...config,
      walletStorageLocation: join(dir, 'wallet'),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    }
    let wallet: EvmChainWalletHandle | undefined
    try {
      wallet = (await createEvmChain(cfg).createWallet(
        roots(),
      )) as EvmChainWalletHandle
      const source = origin === 'main' ? expected[0].main : expected[0].auth
      mockNativeRpc(wallet, { [source]: 500000n })
      // A cancelled native row still contributes source provenance on reopen.
      // That reference must not bypass the separate pool funding hold.
      const failedSignature = jest
        .spyOn(Wallet.prototype, 'signTransaction')
        .mockRejectedValueOnce(new Error('signer unavailable'))
      await expect(
        wallet.sendNative({ recipient: { raw: expected[1].main }, value: 1n }),
      ).rejects.toThrow('signer unavailable')
      failedSignature.mockRestore()
      await wallet.cancelUnsignedNativeOperation!(
        wallet.getNativeOperations!()[0]!.operationId,
      )
      const originalOperations = wallet.getNativeOperations!()
      jest
        .spyOn(wallet.provider, 'getNetwork')
        .mockResolvedValue(Network.from(10143))
      const ActualSigner = jest.requireActual<
        typeof import('../monad-account-tx')
      >('../monad-account-tx').MonadAccountTxSigner
      const submitted = jest.fn(async (raw: string) => keccak256(raw))
      const signer = new ActualSigner({
        privateKey:
          origin === 'main'
            ? expected[0].mainSecret
            : wallet.identity.toPrivateKeyHex(),
        provider: wallet.provider,
        httpClient: {
          submitRawTransaction: submitted,
          getTransactionReceipt: async () => undefined,
        },
      })
      await expect(
        wallet.pool.topUpPool({
          mainAccountSigner: signer,
          burnValue: 1000n,
          gasReserve: 21000n,
          bufferSize: 1,
          overrides: {
            nonce: 0,
            chainId: 10143n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          },
          receipt: { maxAttempts: 0 },
        }),
      ).rejects.toThrow('still pending')
      expect(submitted).toHaveBeenCalledTimes(1)
      const funding = wallet.pool
        .records()
        .find(record => record.status === 'funding')!
      expect(Transaction.from(funding.fundingAttempt!.rawTx).from).toBe(source)
      for (const lifetime of ['current', 'reopened']) {
        if (lifetime === 'reopened') {
          await wallet.close()
          wallet = (await createEvmChain(cfg).createWallet(
            roots(),
          )) as EvmChainWalletHandle
        }
        const rpc = mockNativeRpc(wallet, { [source]: 500000n })
        const signed = jest.fn(async () => undefined)
        for (const method of ['sendNative', 'sendLegacy'] as const)
          await expect(
            wallet[method]!({
              recipient: { raw: expected[1].main },
              value: 100000n,
              onSigned: signed,
            }),
          ).rejects.toThrow('funding')
        expect(signed).not.toHaveBeenCalled()
        expect(rpc.broadcast).not.toHaveBeenCalled()
        expect(wallet.getNativeOperations!()).toEqual(originalOperations)
        expect(
          wallet.pool.records().find(record => record.status === 'funding'),
        ).toEqual(funding)
      }
    } finally {
      await wallet?.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('reopens existing EVM inventory after close even when authentication changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-716-'))
  await mkdir(join(dir, `wallet-evm-${expected[0].main.toLowerCase()}`))
  try {
    const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
    const first = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    first.pool.setStatus(0, 'retired')
    await first.close()
    const second = (await createEvmChain(cfg).createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    })) as EvmChainWalletHandle
    expect(second.pool.getRecord(0)!.status).toBe('retired')
    expect(second.pool.getRecord(0)!.address).toBe(expected[0].pool)
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const CANONICAL_NAMESPACE = 'canonical-stamp-attempts-v1'
async function canonicalJournalEntries(
  storage: string,
): Promise<Array<[string, string]>> {
  const database = level(join(storage, CANONICAL_NAMESPACE))
  try {
    const entries: Array<[string, string]> = []
    for await (const entry of database.iterator({}) as any) entries.push(entry)
    return entries
  } finally {
    await database.close()
  }
}

/** Captured canonical ciphertext with a synthetic offline transaction, pinning pool index 0. */
async function retainedCanonicalAttempt() {
  const wire = dmCorpus.canonical_facade_final_http_case.wire
  const payload = fromHex(wire.payload),
    context = fromHex(wire.context)
  const stampKey = (
    decodeCanonical(context) as Map<bigint, Map<bigint, Uint8Array>>
  )
    .get(8n)!
    .get(1n)!
  const parsed = parseFrame(payload)
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 5)
    throw new Error('fixture payload')
  const material = materialModule.createMonadWalletMaterial(roots())
  let raw: string
  try {
    raw = await new Wallet(
      material.keyring.deriveSubAccount(0).privateKey,
    ).signTransaction({
      chainId: 10143,
      type: 2,
      nonce: 0,
      to: '0x' + wire.destination,
      value: 1n,
      gasLimit: 100000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      data: '0x' + wire.t4,
    })
  } finally {
    material.dispose()
  }
  const delivery = encodeFrame(
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, wire.network],
      [
        1,
        cborMap([
          [0, 1],
          [1, stampKey],
        ]),
      ],
      [2, payload],
      [3, fromHex(wire.t3)],
      [
        4,
        [
          cborMap([
            [0, 0],
            [1, getBytes(Transaction.from(raw).hash!)],
            [2, new Uint8Array(32).map((_, i) => (i === 31 ? 1 : 0))],
            [3, fromHex(wire.destination)],
            [4, fromHex(wire.t4)],
          ]),
        ],
      ],
    ]),
  )
  const prepared: CanonicalPreparedAttempt = {
    walletBindingId: 'wallet-test',
    accountId: expected[0].main.toLowerCase(),
    chainId: '10143',
    network: wire.network,
    senderSubject: toHex(parsed.typed.sender.keyBytes),
    recipientSubject: toHex(parsed.typed.recipient.keyBytes),
    senderT1: wire.sender_t1,
    recipientT1: wire.recipient_t1,
    payload,
    context,
    economicBinding: Uint8Array.of(0xa1, 0, 1),
  }
  return {
    prepared,
    request: freezeCanonicalRequest(
      { delivery, context, transactions: [getBytes(raw)] },
      'foreign-binding-boundary',
    ),
    reservations: [{ id: 'reservation-0', index: 0 }],
    consumerId: 'workflow-0',
  }
}

test('a canonical journal bound to another identity keeps EVM inventory open, refuses canonical messaging and is left untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-825-foreign-'))
  const storage = join(dir, `wallet-evm-${expected[0].main.toLowerCase()}`)
  await mkdir(storage)
  try {
    const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
    const first = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    // Matching (first-bound) identity: canonical client is available, unchanged behaviour.
    expect(canonicalMonadStampClient(first).reconcileWorkflowLinks([])).toEqual(
      [],
    )
    first.pool.setStatus(0, 'retired')
    await first.close()
    const journalBefore = await canonicalJournalEntries(storage)
    expect(journalBefore.map(([key]) => key)).toContain('metadata:binding')
    const rootsBefore = (await readdir(dir)).sort()
    const namespacesBefore = (await readdir(storage)).sort()

    const second = (await createEvmChain(cfg).createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    })) as EvmChainWalletHandle
    expect(second.pool.getRecord(0)!.status).toBe('retired')
    expect(second.pool.getRecord(0)!.address).toBe(expected[0].pool)
    expect(second.pool.getRecord(1)!.status).toBe('unfunded')
    second.pool.setStatus(1, 'retired')
    await second.pool.flush()
    let refusal: unknown
    try {
      canonicalMonadStampClient(second)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(CanonicalWalletBindingMismatchError)
    expect((refusal as CanonicalWalletBindingMismatchError).code).toBe(
      'canonical-wallet:foreign-journal-binding',
    )
    expect(() => prepareMonadRevisionZeroExport(second, {} as never)).toThrow(
      CanonicalWalletBindingMismatchError,
    )
    await second.close()
    expect(await canonicalJournalEntries(storage)).toEqual(journalBefore)
    // No second journal or storage root was created for the changed identity.
    expect((await readdir(dir)).sort()).toEqual(rootsBefore)
    expect((await readdir(storage)).sort()).toEqual(namespacesBefore)

    const third = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    expect(third.pool.getRecord(1)!.status).toBe('retired')
    expect(canonicalMonadStampClient(third).reconcileWorkflowLinks([])).toEqual(
      [],
    )
    await third.close()
    expect(await canonicalJournalEntries(storage)).toEqual(journalBefore)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test('a mismatched open leaves a retained canonical attempt and its pinned pool account intact for the original identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-825-retained-'))
  const storage = join(dir, `wallet-evm-${expected[0].main.toLowerCase()}`)
  await mkdir(storage)
  try {
    const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
    const first = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    first.pool.setStatus(0, 'in-use')
    await first.pool.flush()
    await first.close()
    const journal = new LevelCanonicalStampAttemptJournal(storage)
    await journal.Open()
    const retained = await journal.prepare(await retainedCanonicalAttempt())
    await journal.Close()
    const journalBefore = await canonicalJournalEntries(storage)
    expect(journalBefore.map(([key]) => key)).toEqual([
      'attempt:0000000000000001',
      'manifest',
      'metadata:binding',
      'observations:0000000000000001',
    ])

    const second = (await createEvmChain(cfg).createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    })) as EvmChainWalletHandle
    // The other identity's unresolved obligation still pins its account: an unreferenced
    // in-use account would have been retired during open.
    expect(second.pool.getRecord(0)!.status).toBe('in-use')
    expect(() => canonicalMonadStampClient(second)).toThrow(
      CanonicalWalletBindingMismatchError,
    )
    await second.close()
    expect(await canonicalJournalEntries(storage)).toEqual(journalBefore)

    const third = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    expect(third.pool.getRecord(0)!.status).toBe('in-use')
    expect(canonicalMonadStampClient(third).reconcileWorkflowLinks([])).toEqual(
      [{ attemptRef: retained.attemptRef, state: 'hold' }],
    )
    await third.close()
    expect(await canonicalJournalEntries(storage)).toEqual(journalBefore)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test('construction failure closes opened stores and wipes owned messaging root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-716-failure-'))
  await mkdir(join(dir, `wallet-evm-${expected[0].main.toLowerCase()}`))
  const original = materialModule.createMonadWalletMaterial
  let material: materialModule.MonadWalletMaterial | undefined
  jest
    .spyOn(materialModule, 'createMonadWalletMaterial')
    .mockImplementation(input => (material = original(input)))
  const close = jest.spyOn(LevelSubAccountPoolStore.prototype, 'Close')
  const open = jest
    .spyOn(LevelStampPaymentJournal.prototype, 'Open')
    .mockRejectedValueOnce(new Error('fixture open failure'))
  const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
  try {
    const chain = createEvmChain(cfg)
    await expect(chain.createWallet(roots())).rejects.toThrow(
      'fixture open failure',
    )
    expect(close).toHaveBeenCalled()
    expect(material!.messagingRoot!.every(byte => byte === 0)).toBe(true)
    open.mockRestore()
    const recovered = await chain.createWallet(roots())
    await recovered.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed fake discovery creates no providers, wipes owned material and releases ownership for retry', async () => {
  const original = materialModule.createMonadWalletMaterial
  const materials: materialModule.MonadWalletMaterial[] = []
  jest
    .spyOn(materialModule, 'createMonadWalletMaterial')
    .mockImplementation(input => {
      const material = original(input)
      materials.push(material)
      return material
    })
  const provider = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
  const open = jest.spyOn(LevelSubAccountPoolStore.prototype, 'Open')
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok: false } as Response)
  const chain = createEvmChain({
    ...config,
    networkId: 'monad-testnet',
    fakeDemo: { enabled: true, controlUrl: 'http://127.0.0.1:8545' },
  })
  await expect(chain.createWallet(roots())).rejects.toThrow('capability')
  expect(provider).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(materials[0].messagingRoot!.every(byte => byte === 0)).toBe(true)
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      kind: 'frank-simulated-ledger-v1',
      amountWei: '1000000000000000000',
      token: 'ab'.repeat(32),
    }),
  } as Response)
  const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  expect(
    provider.mock.calls.map(([options]) => [options.rpcUrl, options.relayAuth]),
  ).toEqual([
    ['http://127.0.0.1:8545', undefined],
    ['http://127.0.0.1:8545', undefined],
  ])
  const destroy = jest.spyOn(MonadHttpClient.prototype, 'destroy')
  await wallet.close()
  expect(destroy).toHaveBeenCalledTimes(1)
  expect(wallet.provider.destroyed).toBe(true)
  expect(materials[1].messagingRoot!.every(byte => byte === 0)).toBe(true)
})

test('construction failure after both clients exist destroys both providers', async () => {
  const providers = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
  jest
    .spyOn(MonadStampClient.prototype, 'resumePendingAttempts')
    .mockRejectedValue(new Error('fixture resume failure'))
  await expect(
    createEvmChain(config).createWallet({
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    }),
  ).rejects.toThrow('fixture resume failure')
  expect(providers.mock.results).toHaveLength(2)
  expect(providers.mock.results.every(result => result.value.destroyed)).toBe(
    true,
  )
})

test('demo wallet close cancels dispatched balance and HTTP reads and closes their sockets', async () => {
  const methods = new Set<string>()
  let readsStarted!: () => void
  const started = new Promise<void>(resolve => {
    readsStarted = resolve
  })
  const socketClosures: Promise<void>[] = []
  const server = createServer((req, res) => {
    if (req.url === '/_ctl/demo-funding') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          kind: 'frank-simulated-ledger-v1',
          amountWei: '1000000000000000000',
          token: 'ab'.repeat(32),
        }),
      )
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      socketClosures.push(
        new Promise<void>(resolve => res.on('close', resolve)),
      )
      const payload = JSON.parse(body)
      for (const item of Array.isArray(payload) ? payload : [payload])
        methods.add(item.method)
      if (methods.has('eth_getBalance') && methods.has('eth_blockNumber'))
        readsStarted()
      // Both dispatched client reads intentionally wait forever for a response.
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const controlUrl = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }`
  const wallet = (await createEvmChain({
    ...config,
    networkId: 'monad-testnet',
    fakeDemo: { enabled: true, controlUrl },
  }).createWallet(roots())) as EvmChainWalletHandle
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const reads = Promise.allSettled([
      wallet.getBalance(),
      wallet.httpClient.getBlockNumber(),
    ])
    await started
    await wallet.close()
    const outcomes = await Promise.race([
      reads,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('dispatched demo reads stayed pending')),
          300,
        )
      }),
    ])
    expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected')
        expect(outcome.reason.message).toMatch(/cancel|destroy/i)
    }
    await Promise.race([
      Promise.all(socketClosures),
      new Promise<never>((_resolve, reject) => {
        clearTimeout(timeout)
        timeout = setTimeout(
          () => reject(new Error('demo RPC socket stayed open')),
          300,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
    await wallet.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test.each([undefined, false])(
  'production capability 401 never probes or retries direct (flag %s)',
  async enabled => {
    const paths: string[] = []
    const server = createServer((req, res) => {
      paths.push(req.url!)
      res.setHeader('content-type', 'application/json')
      if (req.url!.endsWith('/capability/auth')) {
        res.end(
          JSON.stringify({
            signing_domain: 'frank:rpc-http-auth:v1',
            customer: req.headers['x-frank-rpc-customer'],
            chain: 'monad-testnet',
            network_tag: '4d4f4e54',
            body_sha256:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            epoch: '01'.repeat(32),
            nonce: '02'.repeat(32),
            token: '03'.repeat(32),
            expires_at_ms: Date.now() + 60000,
          }),
        )
      } else {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'rpc_auth_failed' }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const wallet = await createEvmChain({
      ...config,
      relayBaseUrl: url,
      fakeDemo:
        enabled === undefined ? undefined : { enabled, controlUrl: url },
    }).createWallet(roots())
    try {
      await expect(wallet.getBalance()).rejects.toThrow('401')
      expect(paths).toEqual([
        '/chain-rpc/monad-testnet/capability/auth',
        '/chain-rpc/monad-testnet/capability',
      ])
    } finally {
      await wallet.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  },
)

test.each([
  'main',
  'identity',
  'spend',
  'change',
  'identity-stealth-v1',
] as const)(
  'reopens canceled unsigned %s provenance and signs only through owned custody',
  async kind => {
    const dir = await mkdtemp(join(tmpdir(), 'frank-native-custody-'))
    const cfg = {
      ...config,
      walletStorageLocation: join(dir, 'wallet'),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    }
    let first: EvmChainWalletHandle | undefined
    let second: EvmChainWalletHandle | undefined
    try {
      first = (await createEvmChain(cfg).createWallet(
        roots(),
      )) as EvmChainWalletHandle
      let sourceAddress =
        kind === 'main'
          ? expected[0].main
          : kind === 'identity'
          ? expected[0].auth
          : kind === 'spend'
          ? expected[0].pool
          : expected[0].change
      if (kind === 'identity-stealth-v1') {
        const { deriveEvmStealthPrivateKey } = await import('../monad-stealth')
        const ephemeral = new Wallet('0x' + '55'.repeat(32)).signingKey
          .compressedPublicKey
        const derived = deriveEvmStealthPrivateKey({
          recipientSpendSecret: first.identity.toPrivateKeyHex(),
          ephemeralPubKey: getBytes(ephemeral),
        })
        sourceAddress = derived.stealthAddress
        await first.stealthKeyring!.addAccount({
          address: sourceAddress,
          // Deliberately wrong attached secret: provenance, not the construction view, owns signing.
          privateKey: '0x' + '56'.repeat(32),
          ephemeralPubKey: ephemeral,
          networkTag: 'MONT',
          discoveredAtMs: 1,
          balanceWei: 100000n,
        })
      }
      const rpc = mockNativeRpc(first, { [sourceAddress]: 100000n })
      const cannotSign = jest
        .spyOn(Wallet.prototype, 'signTransaction')
        .mockRejectedValueOnce(new Error('interrupted before signature'))
      await expect(
        first.sendNative({
          recipient: { raw: expected[1].main },
          value: 1000n,
        }),
      ).rejects.toThrow('interrupted before signature')
      cannotSign.mockRestore()
      const row = first.getNativeOperations!()[0]!
      expect(row.members[0]!.source.kind).toBe(kind)
      expect(row.members[0]!.signed).toBeNull()
      expect(rpc.broadcast).not.toHaveBeenCalled()
      await first.cancelUnsignedNativeOperation!(row.operationId)
      await first.close()
      second = (await createEvmChain(cfg).createWallet(
        roots(),
      )) as EvmChainWalletHandle
      if (kind === 'identity-stealth-v1')
        expect(
          second
            .stealthKeyring!.getAccounts('MONT')
            .some(a => a.address === sourceAddress),
        ).toBe(true)
      const recovered = mockNativeRpc(second, { [sourceAddress]: 100000n })
      await second.sendNative({
        recipient: { raw: expected[1].main },
        value: 1000n,
      })
      expect(Transaction.from(recovered.broadcast.mock.calls[0]![0]).from).toBe(
        sourceAddress,
      )
      expect(second.getNativeOperations!()[0]!.cancelled).toBe(true)
      expect(second.getNativeOperations!()[0]!.members[0]!.source).toEqual(
        row.members[0]!.source,
      )
    } finally {
      await second?.close()
      await first?.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('a funded key-only imported account cannot become native custody authority', async () => {
  const wallet = (await createEvmChain(config).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  try {
    const stranger = new Wallet('0x' + '67'.repeat(32))
    const coin = wallet.accountUtxoPool!.registerSubAccount({
      chain: 'monad',
      address: stranger.address,
      privateKey: stranger.privateKey,
      balanceWei: 100000n,
    })
    const rpc = mockNativeRpc(wallet, { [stranger.address]: 100000n })
    await expect(
      wallet.sendNative({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('no recoverable custody reference')
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(wallet.accountUtxoPool!.getCoin(coin.id)?.balanceWei).toBe(100000n)
    expect(wallet.getNativeOperations!()).toEqual([])
  } finally {
    await wallet.close()
  }
})

test('native recovery references load before startup orphan retirement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-native-lease-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  let first: EvmChainWalletHandle | undefined
  let second: EvmChainWalletHandle | undefined
  try {
    first = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    const rpc = mockNativeRpc(first, { [expected[0].pool]: 100000n })
    rpc.broadcast.mockRejectedValueOnce(new Error('lost response'))
    await expect(
      first.sendNative({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('unknown')
    const row = first.getNativeOperations!()[0]!
    first.pool.setStatus(0, 'in-use')
    await first.pool.flush()
    await first.close()
    second = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    expect(second.pool.getRecord(0)!.status).toBe('in-use')
    const recovered = mockNativeRpc(second, { [expected[0].pool]: 100000n })
    await second.resumeNativeOperation!(row.operationId)
    expect(recovered.broadcast).toHaveBeenCalledWith(
      row.members[0]!.signed!.rawTransaction,
    )
  } finally {
    await second?.close()
    await first?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Wallets the #1235 helpers opened; closed after each test even when a helper assertion fails. */
const spendRecordWallets: EvmChainWalletHandle[] = []
afterEach(async () => {
  for (const opened of spendRecordWallets.splice(0))
    await opened.close().catch(() => undefined)
})

/** Stage 0 of #1235. Row 0 is funded through the pool's own on-demand path, then out-holds main,
 * so the legacy send selects it as its single source and the mocked RPC includes it in-call. */
async function sendLegacyFromProductionFundedPoolRow(dir: string) {
  const bundleModule = jest.requireActual(
    '../storage/monad-wallet-bundle',
  ) as typeof import('../storage/monad-wallet-bundle')
  const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
  const opened: Array<Awaited<ReturnType<typeof originalOpen>>> = []
  jest
    .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
    .mockImplementation(async params => {
      const result = await originalOpen(params)
      opened.push(result)
      return result
    })
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  const open = async () => {
    const chain = createEvmChain(cfg)
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    spendRecordWallets.push(wallet)
    const bundle = opened[opened.length - 1]!
    return {
      wallet,
      bundle,
      // Calls through: the real transport step, observed.
      transport: jest.spyOn(chain.directMessages, 'send'),
      admission: () =>
        bundle.runLifetime(lifetime =>
          Promise.resolve(bundle.inputAdmission.inspect(lifetime)),
        ),
    }
  }
  const first = await open()
  const wallet = first.wallet
  const poolAddress = expected[0].pool.toLowerCase()
  const rpc = mockNativeRpc(wallet, { [expected[0].main]: 1000000n })
  jest
    .spyOn(wallet.provider, 'getNetwork')
    .mockResolvedValue(Network.from(10143))
  const ActualSigner = jest.requireActual<typeof import('../monad-account-tx')>(
    '../monad-account-tx',
  ).MonadAccountTxSigner
  const funder = new ActualSigner({
    privateKey: expected[0].mainSecret,
    provider: wallet.provider,
    httpClient: {
      submitRawTransaction: async (raw: string) => {
        const tx = Transaction.from(raw)
        await wallet.provider.broadcastTransaction(raw)
        const to = tx.to!.toLowerCase()
        rpc.balances.set(to, (rpc.balances.get(to) ?? 0n) + tx.value)
        return tx.hash!
      },
      getTransactionReceipt: async (txHash: string) =>
        ({ txHash, status: 'success' } as never),
    },
  })
  await wallet.pool.prepareStampInventory({
    mainAccountSigner: funder,
    provider: wallet.provider,
    stampValueWei: 1n,
    gasReserveWei: 21000n,
    fundingOverrides: {
      nonce: 0,
      chainId: 10143n,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    },
  })
  expect(wallet.pool.getRecord(0)).toEqual({
    index: 0,
    address: expected[0].pool,
    status: 'available',
  })
  expect(wallet.pool.capacityCache.has(0)).toBe(true)
  // The pool account now out-holds main and covers the send exactly; main cannot cover it.
  rpc.balances.set(poolAddress, 121000n)
  rpc.balances.set(expected[0].main.toLowerCase(), 50000n)
  rpc.broadcast.mockClear()
  const processed = jest.spyOn(wallet.pool, 'processSyncTransaction')
  const sent = await wallet
    .sendLegacy!({ recipient: { raw: expected[1].main }, value: 100000n })
    .then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
  const operation = wallet.getNativeOperations!()[0]!
  expect(operation.members).toHaveLength(1)
  const member = operation.members[0]!
  expect(member.source).toEqual({
    kind: 'spend',
    address: poolAddress,
    index: 0,
  })
  expect(member.observation.state).toBe('included-success')
  expect(rpc.broadcast).toHaveBeenCalledTimes(1)
  expect(rpc.broadcast).toHaveBeenCalledWith(member.signed!.rawTransaction)
  // Stage 1 of #1235 changed these assertions on purpose. They used to pin that the native
  // callback dispatched its own item to the pool (`processed` called once). This device's own
  // record is written by the local pass inside the send.
  //
  // Changed again, on purpose: the send used to hand a wallet-sync note to the message path
  // afterwards. A note is a paid message, so the wallet no longer sends one: nothing reaches the
  // message path, and the member stays not sync-applied.
  expect(processed).not.toHaveBeenCalled()
  expect(first.transport).not.toHaveBeenCalled()
  expect(member.syncApplied).toBe(false)
  return { ...first, rpc, sent, operation, open }
}

/** What Stage 1 writes for the helper's send: the member's bytes and hash, the transaction's own
 * value (the 21000 wei fee the send observed is not part of it), and `spent`, in one row. */
function spentByMember(
  operation: ReturnType<NonNullable<EvmChainWalletHandle['getNativeOperations']>>[number],
) {
  const signed = operation.members[0]!.signed!
  expect(operation.members[0]!.observation).toMatchObject({ feeWei: '21000' })
  return {
    index: 0,
    address: expected[0].pool,
    status: 'spent',
    lifecycle: {
      spend: {
        rawTx: signed.rawTransaction,
        txHash: signed.transactionHash,
        valueWei: Transaction.from(signed.rawTransaction).value.toString(),
      },
    },
  }
}

function expectNoSpendRecordWithoutItsTransaction(wallet: EvmChainWalletHandle) {
  for (const row of [
    ...wallet.pool.records(),
    ...wallet.pool.terminalCheckpoints(),
  ]) {
    const spend = row.lifecycle?.spend
    if (spend === undefined) continue
    expect(Transaction.from(spend.rawTx).hash).toBe(spend.txHash)
  }
}

test('a pool-sourced legacy send included in-call leaves a wallet that reopens (#1235)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-1235-spend-record-reopen-'))
  let wallet: EvmChainWalletHandle | undefined
  try {
    const first = await sendLegacyFromProductionFundedPoolRow(dir)
    wallet = first.wallet
    await wallet.close()
    wallet = undefined
    const second = await first.open()
    wallet = second.wallet
    // Stage 1 of #1235 changed this assertion on purpose: Stage 0 pinned the row as still
    // `available` here ("the next stage marks it from the journal member"). This is that stage.
    // On main 72631f36 the row is `available` with no checkpoint.
    const snapshot = await second.admission()
    expect(snapshot).toMatchObject({ status: 'ready' })
    expect(wallet.pool.getRecord(0)).toEqual(spentByMember(first.operation))
    expect(
      Transaction.from(first.operation.members[0]!.signed!.rawTransaction)
        .value,
    ).toBe(100000n)
    if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
    // One authorization: the native member, and one retained pool claim for the same bytes.
    expect(snapshot.obligations.map(claim => claim.provenance)).toEqual([
      {
        kind: 'native',
        operationId: first.operation.operationId,
        member: 0,
        source: first.operation.members[0]!.source,
      },
      { kind: 'pool-retained', poolIndex: 0, role: 'spend' },
    ])
    expect(snapshot.obligations[1]!.transaction!.transactionHash).toBe(
      first.operation.members[0]!.signed!.transactionHash,
    )
    // The same pair cannot be claimed again; the account is terminal and never selectable.
    const samePair = {
      kind: 'native' as const,
      recipient: expected[1].main.toLowerCase(),
      intendedValueWei: '1',
      members: [
        {
          source: first.operation.members[0]!.source,
          dependencies: [],
          unsignedTransaction: first.operation.members[0]!.unsignedTransaction,
        },
      ],
    }
    await expect(
      second.bundle.runLifetime(async lifetime => {
        const current = second.bundle.inputAdmission.inspect(lifetime)
        if (current.status !== 'ready') throw new Error(current.reason)
        return second.bundle.inputAdmission.prepareNative(
          lifetime,
          current.epoch,
          samePair,
        )
      }),
    ).rejects.toThrow('conflicting-authorization')
    mockNativeRpc(wallet, { [expected[0].pool]: 500000n })
    expect(await wallet.pool.fundedCapacities(wallet.provider, 21000n)).toEqual(
      [],
    )
    expect(wallet.pool.selectForStamp()).toBeUndefined()
    expect(() => wallet!.leaseManager.acquireLease()).toThrow(
      NoAvailableSubAccountError,
    )
    expectNoSpendRecordWithoutItsTransaction(wallet)
    expect(wallet.getNativeOperations!()).toEqual([first.operation])
    expect(first.operation.members[0]!.syncApplied).toBe(false)
  } finally {
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a pool-sourced legacy send included in-call keeps admission ready in the same session (#1235)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-1235-spend-record-session-'))
  let wallet: EvmChainWalletHandle | undefined
  try {
    const first = await sendLegacyFromProductionFundedPoolRow(dir)
    wallet = first.wallet
    expect(await first.admission()).toMatchObject({ status: 'ready' })
    // Stage 1 of #1235 changed this assertion on purpose: the row was pinned `available` here
    // until the stage that records the spend. On main 72631f36 it is `available`.
    expect(wallet.pool.getRecord(0)).toEqual(spentByMember(first.operation))
    expectNoSpendRecordWithoutItsTransaction(wallet)
    // The drained account is not offered from the stale funded-capacity entry, nor at all: it
    // went from reserved by the journal member straight to terminal.
    expect(wallet.pool.isSpendReserved(0)).toBe(true)
    expect(wallet.pool.capacityCache.has(0)).toBe(false)
    expect(
      await wallet.pool.fundedCapacities(wallet.provider, 21000n),
    ).toEqual([])
    // A native send for a disjoint pair (main, not the drained account) is still admitted,
    // signed and broadcast.
    first.rpc.broadcast.mockClear()
    await wallet
      .sendNative({ recipient: { raw: expected[1].main }, value: 1000n })
      .catch(() => undefined)
    expect(first.rpc.broadcast).toHaveBeenCalledTimes(1)
    const next = Transaction.from(first.rpc.broadcast.mock.calls[0]![0])
    expect(next.from).toBe(expected[0].main)
    expect(wallet.getNativeOperations!()).toHaveLength(2)
    expect(await first.admission()).toMatchObject({ status: 'ready' })
  } finally {
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// Stage 1 of #1235 pinned that this send ended in the pending error, from the transport step's
// refusal, with the row recorded spent. The wallet no longer transports a note at all (it is a
// paid message), so a send whose transfer is included RESOLVES: there is no step left to refuse
// it. The row is still recorded, and resuming still changes nothing and signs nothing.
test('a pool-sourced legacy send whose transfer is included resolves, with the row recorded spent and no note sent; resuming changes nothing and signs nothing (#1235)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-1235-spend-record-pending-'))
  let wallet: EvmChainWalletHandle | undefined
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const first = await sendLegacyFromProductionFundedPoolRow(dir)
    wallet = first.wallet
    expect(first.sent.error).toBeUndefined()
    expect(first.sent.value).toMatchObject({
      txHash: first.operation.members[0]!.signed!.transactionHash,
      totalValueSent: 100000n,
    })
    expect(first.operation.members[0]!.syncApplied).toBe(false)
    expect(await first.admission()).toMatchObject({ status: 'ready' })
    const row = spentByMember(first.operation)
    expect(wallet.pool.getRecord(0)).toEqual(row)
    // Resuming the fulfilled operation, twice: no signature, no broadcast, no pool write, and
    // the same result.
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    first.rpc.broadcast.mockClear()
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await wallet.resumeLegacySend!(first.operation.operationId),
      ).toMatchObject({
        txHash: first.operation.members[0]!.signed!.transactionHash,
      })
    expect(first.transport).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(first.rpc.broadcast).not.toHaveBeenCalled()
    expect(putMany).not.toHaveBeenCalled()
    expect(wallet.pool.getRecord(0)).toEqual(row)
    expect(wallet.getNativeOperations!()[0]!.members[0]!.syncApplied).toBe(false)
    await wallet.close()
    wallet = undefined
    const second = await first.open()
    wallet = second.wallet
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    expect(wallet.getNativeOperations!()).toEqual([first.operation])
    expect(wallet.pool.getRecord(0)).toEqual(row)
    await new Promise(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Stage 1 of #1235. A composed, file-backed wallet whose pool row 0 was funded by the pool's own
 * on-demand burn-account path (121000 wei) and then out-holds main, with NO native operation
 * yet. `open` reopens the same storage and carries the simulated chain across. */
async function composedWithProductionFundedPoolRow(dir: string) {
  const bundleModule = jest.requireActual(
    '../storage/monad-wallet-bundle',
  ) as typeof import('../storage/monad-wallet-bundle')
  const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
  const opened: Array<Awaited<ReturnType<typeof originalOpen>>> = []
  jest
    .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
    .mockImplementation(async params => {
      const result = await originalOpen(params)
      opened.push(result)
      return result
    })
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  const main = expected[0].main.toLowerCase()
  const poolAddress = expected[0].pool.toLowerCase()
  const ActualSigner = jest.requireActual<typeof import('../monad-account-tx')>(
    '../monad-account-tx',
  ).MonadAccountTxSigner
  const material = materialModule.createMonadWalletMaterial(roots())
  const poolKey = material.keyring.deriveSubAccount(0).privateKey
  material.dispose()
  let chainState: ReturnType<typeof mockNativeRpc> | undefined
  const open = async (balances?: Record<string, bigint>) => {
    const chain = createEvmChain(cfg)
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    spendRecordWallets.push(wallet)
    const bundle = opened[opened.length - 1]!
    const rpc = mockNativeRpc(
      wallet,
      balances ?? Object.fromEntries(chainState!.balances),
      chainState ? Object.fromEntries(chainState.nonces) : {},
      chainState,
    )
    chainState = rpc
    jest
      .spyOn(wallet.provider, 'getNetwork')
      .mockResolvedValue(Network.from(10143))
    const receipt = jest.spyOn(wallet.provider, 'getTransactionReceipt')
    const visibleReceipt = receipt.getMockImplementation()!
    const funder = new ActualSigner({
      privateKey: expected[0].mainSecret,
      provider: wallet.provider,
      httpClient: {
        submitRawTransaction: async (raw: string) => {
          const tx = Transaction.from(raw)
          await wallet.provider.broadcastTransaction(raw)
          const to = tx.to!.toLowerCase()
          rpc.balances.set(to, (rpc.balances.get(to) ?? 0n) + tx.value)
          return tx.hash!
        },
        getTransactionReceipt: async (txHash: string) =>
          ({ txHash, status: 'success' } as never),
      },
    })
    const snapshot = () =>
      bundle.runLifetime(lifetime =>
        Promise.resolve(bundle.inputAdmission.inspect(lifetime)),
      )
    return {
      wallet,
      bundle,
      rpc,
      transport: jest.spyOn(chain.directMessages, 'send'),
      admission: snapshot,
      /** The ready projection as plain data, so two sessions or two wallets can be compared. */
      obligations: async () => {
        const state = await snapshot()
        if (state.status !== 'ready') throw new Error(state.reason)
        return JSON.parse(JSON.stringify(state.obligations)) as Array<{
          provenance: Record<string, unknown>
          transaction: { transactionHash: string } | null
        }>
      },
      /** The node keeps the transaction and returns no receipt until `false` is passed. */
      withholdReceipts: (withheld: boolean) =>
        receipt.mockImplementation(async hash =>
          withheld ? null : visibleReceipt(hash),
        ),
      prepareBurn: () =>
        wallet.pool.prepareBurnAccount({
          mainAccountSigner: funder,
          provider: wallet.provider,
          burnValueWei: 100000n,
          gasReserveWei: 21000n,
          fundingOverrides: {
            chainId: 10143n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          },
        }),
      /** A legacy send that only the pool account can cover (main holds 40000). */
      sendFromPool: () =>
        wallet.sendLegacy!({
          recipient: { raw: expected[1].main },
          value: 100000n,
        }),
      /** A native send main covers; the pool account, drained or reserved, is not its source. */
      sendFromMain: async () => {
        rpc.balances.set(main, 500000n)
        return wallet.sendNative({
          recipient: { raw: expected[1].main },
          value: 1000n,
        })
      },
    }
  }
  const first = await open({ [main]: 1000000n })
  expect(await first.prepareBurn()).toMatchObject({ index: 0 })
  expect(first.wallet.pool.getRecord(0)).toEqual({
    index: 0,
    address: expected[0].pool,
    status: 'available',
  })
  expect(first.rpc.balances.get(poolAddress)).toBe(121000n)
  first.rpc.balances.set(main, 40000n)
  first.rpc.broadcast.mockClear()
  expect(first.wallet.getNativeOperations!()).toEqual([])
  /** A transaction the pool account's own key signed, and the complete sync item for it. */
  const signedByPoolKey = async (
    fields: Record<string, unknown> = {},
    key = poolKey,
  ) => {
    const rawTx = await new Wallet(key).signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: expected[1].main,
      value: 100000n,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      ...fields,
    })
    return { rawTx, item: itemFor(rawTx) }
  }
  const itemFor = (rawTx: string): WalletSyncItem => {
    const tx = Transaction.from(rawTx)
    return {
      type: 'wallet-sync',
      direction: 'out',
      chainIdentifier: 'monad-testnet',
      txHash: tx.hash!,
      rawTx,
      spentInputs: [
        {
          address: poolAddress,
          nonce: tx.nonce,
          valueWei: (tx.value + 21000n).toString(),
        },
      ],
      createdOutputs: [{ address: tx.to!, valueWei: tx.value.toString() }],
      timestamp: 1,
    }
  }
  return { ...first, open, main, poolAddress, signedByPoolKey, itemFor }
}
const availableRow = { index: 0, address: expected[0].pool, status: 'available' }
const settled = (promise: Promise<unknown>) =>
  promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )

describe('recording a native spend from the journal under the input admission (#1235 Stage 1)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frank-1235-stage-1-'))
  })
  afterEach(async () => {
    for (const opened of spendRecordWallets.splice(0))
      await opened.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  // Path 2a, the normal production path. On main 72631f36 the first operation's row is never
  // `spent`: nothing applies an operation other than the one being flushed.
  test('a member pending in its own call is recorded by a LATER native send, whose result names only the later operation', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    f.withholdReceipts(true)
    const first = await settled(f.sendFromPool())
    expect(first.error).toBeInstanceOf(EvmNativeOperationPendingError)
    const earlier = wallet.getNativeOperations!()[0]!
    expect(earlier.members[0]!.source).toMatchObject({ kind: 'spend', index: 0 })
    expect(earlier.members[0]!.observation.state).toBe('pending')
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(f.transport).not.toHaveBeenCalled()
    // The receipt appears. Nothing looks until the next native send plans.
    f.withholdReceipts(false)
    f.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    const later = await f.sendFromMain()
    const [, second] = wallet.getNativeOperations!()
    expect(second!.members[0]!.source).toMatchObject({ kind: 'main' })
    expect(later).toEqual({
      txHash: second!.members[0]!.signed!.transactionHash,
    })
    expect(wallet.getNativeOperations!()[0]!.members[0]!.observation.state).toBe(
      'included-success',
    )
    expect(wallet.pool.getRecord(0)).toEqual(
      spentByMember(wallet.getNativeOperations!()[0]!),
    )
    expect(putMany).toHaveBeenCalledTimes(1)
    // The later call transported nothing of the earlier operation.
    expect(f.transport).not.toHaveBeenCalled()
    expect(await f.admission()).toMatchObject({ status: 'ready' })
    expect(wallet.pool.selectForStamp()).toBeUndefined()
    await wallet.close()
    const reopened = await f.open()
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
    expect(reopened.wallet.pool.getRecord(0)!.status).toBe('spent')
  })

  // Contract tests 6 and 32, with a queued native send standing in for the canonical send and the
  // on-demand preparation: all three wait on the same wallet queue. On main the row is `available`
  // when the queued operation runs.
  test('the row is recorded before the send releases the wallet queue: an operation queued behind it finds it spent', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    f.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    const seen: unknown[] = []
    const first = f.sendFromPool()
    // Main (40000) covers this one; it cannot cover the legacy send ahead of it.
    const queued = wallet.sendNative({
      recipient: { raw: expected[1].main },
      value: 1000n,
      // Inside the queued operation's own hold, before its own pass.
      onSigned: async () => void seen.push(wallet.pool.getRecord(0)),
    })
    const result = await first
    await queued
    const [operation] = wallet.getNativeOperations!()
    expect(result).toEqual({
      txHash: operation!.members[0]!.signed!.transactionHash,
      intermediateTxHashes: [],
      totalValueSent: 100000n,
      totalFeePaid: 21000n,
    })
    expect(seen).toEqual([spentByMember(operation!)])
    // No note is sent after the send, so nothing reaches the message path and the member is
    // not marked sync-applied.
    expect(wallet.getNativeOperations!()[0]!.members[0]!.syncApplied).toBe(false)
    expect(f.transport).not.toHaveBeenCalled()
  })

  // Contract test 26: restores what Stage 0b's test 10 refused. On main 72631f36 the item is
  // refused (`no-applier`) and nothing is written.
  test('caller B: a complete item for a production-funded row with no journal member commits through the real applier, inside the wallet queue, and reopens ready', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    const { rawTx, item } = await f.signedByPoolKey()
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    // Another chain's transaction, a transaction with no chain ID, and another chain's item.
    for (const fields of [{ chainId: 1 }, { type: 0, chainId: 0, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }]) {
      const foreign = await f.signedByPoolKey(fields)
      expect(await settled(applyWalletSyncItem(wallet, foreign.item))).toMatchObject(
        { error: { reason: 'invalid-provenance' } },
      )
    }
    await expect(
      applyWalletSyncItem(wallet, { ...item, chainIdentifier: 'ethereum-sepolia' }),
    ).rejects.toMatchObject({ code: 'chain-mismatch' })
    // A valid transaction some other key signed, in an item naming the pool row.
    const outsider = await f.signedByPoolKey({}, expected[0].mainSecret)
    await expect(applyWalletSyncItem(wallet, outsider.item)).rejects.toMatchObject({
      code: 'inconsistent-item',
      index: 0,
    })
    expect(putMany).not.toHaveBeenCalled()
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(await f.obligations()).toEqual([])

    // Inside the wallet queue: while a native send holds it, the item waits.
    let release!: () => void
    let entered!: () => void
    const holding = new Promise<void>(resolve => (entered = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    f.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    f.rpc.balances.set(f.main, 500000n)
    const send = wallet.sendNative({
      recipient: { raw: expected[1].main },
      value: 1000n,
      onSigned: async () => {
        entered()
        await held
      },
    })
    await holding
    const dispatched = applyWalletSyncItem(wallet, item)
    await new Promise(resolve => setImmediate(resolve))
    expect(putMany).not.toHaveBeenCalled()
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    release()
    await send
    expect(await dispatched).toEqual({ affectedIndices: [0] })
    expect(putMany).toHaveBeenCalledTimes(1)
    const tx = Transaction.from(rawTx)
    const row = {
      index: 0,
      address: expected[0].pool,
      status: 'spent',
      lifecycle: { spend: { rawTx, txHash: tx.hash, valueWei: '100000' } },
    }
    expect(wallet.pool.getRecord(0)).toEqual(row)
    const retained = async (session: { obligations: typeof f.obligations }) =>
      (await session.obligations())
        .filter(claim => claim.provenance.kind !== 'native')
        .map(claim => [claim.provenance, claim.transaction?.transactionHash])
    const projected = [
      [{ kind: 'pool-retained', poolIndex: 0, role: 'spend' }, tx.hash],
    ]
    expect(await retained(f)).toEqual(projected)
    // Repeating it is a no-op.
    expect(await applyWalletSyncItem(wallet, item)).toEqual({})
    expect(putMany).toHaveBeenCalledTimes(1)
    await wallet.close()
    const second = await f.open()
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    expect(await retained(second)).toEqual(projected)
    expect(second.wallet.pool.getRecord(0)).toEqual(row)
    expect(second.wallet.pool.selectForStamp()).toBeUndefined()
    expectNoSpendRecordWithoutItsTransaction(second.wallet)
  })

  // Contract tests 27 and 29. On main 72631f36 every dispatch here is refused (`no-applier`) and
  // no later send records the row.
  test.each(['caller A then caller B', 'caller B then caller A'] as const)(
    'the journal governs: while its member is pending a complete item is held, also with other bytes; once included, %s is one write and a no-op, and both orders project the same',
    async order => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      f.withholdReceipts(true)
      await settled(f.sendFromPool())
      const member = wallet.getNativeOperations!()[0]!.members[0]!
      const item = f.itemFor(member.signed!.rawTransaction)
      const other = await f.signedByPoolKey({ value: 99999n })
      const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
      const heldByJournal = async () => {
        for (const candidate of [item, other.item])
          expect(await settled(applyWalletSyncItem(wallet, candidate))).toMatchObject(
            { error: { reason: 'conflicting-authorization' } },
          )
        expect(putMany).not.toHaveBeenCalled()
        expect(wallet.pool.getRecord(0)).toEqual(availableRow)
      }
      // Pending in the journal.
      await heldByJournal()
      // Mined on chain, but the journal has not observed it: the journal still governs.
      f.withholdReceipts(false)
      await heldByJournal()
      expect(await f.admission()).toMatchObject({ status: 'ready' })
      // A fee estimate observes inclusion and applies nothing.
      await wallet.estimateLegacyFee!({
        recipient: { raw: expected[1].main },
        value: 1n,
      })
      expect(
        wallet.getNativeOperations!()[0]!.members[0]!.observation.state,
      ).toBe('included-success')
      expect(wallet.pool.getRecord(0)).toEqual(availableRow)
      f.transport.mockRejectedValue(new Error('transport unsupported'))
      if (order === 'caller B then caller A') {
        expect(await applyWalletSyncItem(wallet, item)).toEqual({
          affectedIndices: [0],
        })
        await f.sendFromMain()
      } else {
        await f.sendFromMain()
        expect(await applyWalletSyncItem(wallet, item)).toEqual({})
      }
      expect(putMany).toHaveBeenCalledTimes(1)
      const operation = wallet.getNativeOperations!()[0]!
      expect(wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
      // Either order again: nothing more is written, and other bytes for the pair stay refused.
      expect(await applyWalletSyncItem(wallet, item)).toEqual({})
      await expect(applyWalletSyncItem(wallet, other.item)).rejects.toBeInstanceOf(
        Error,
      )
      expect(putMany).toHaveBeenCalledTimes(1)
      const projected = await f.obligations()
      expect(projected.map(claim => claim.provenance.kind)).toEqual([
        'native',
        'native',
        'pool-retained',
      ])
      // The same for both orders: nothing in the projection depends on who wrote the row.
      expect(
        projected.map(claim => [
          claim.provenance,
          claim.transaction?.transactionHash,
        ]),
      ).toEqual([
        [
          {
            kind: 'native',
            operationId: operation.operationId,
            member: 0,
            source: operation.members[0]!.source,
          },
          operation.members[0]!.signed!.transactionHash,
        ],
        [
          expect.objectContaining({ kind: 'native', member: 0 }),
          wallet.getNativeOperations!()[1]!.members[0]!.signed!.transactionHash,
        ],
        [
          { kind: 'pool-retained', poolIndex: 0, role: 'spend' },
          operation.members[0]!.signed!.transactionHash,
        ],
      ])
      await wallet.close()
      const second = await f.open()
      expect(await second.obligations()).toEqual(projected)
    },
  )

  // Contract test 28. HAND-BUILT: the retained canonical pre-sign intent is injected at the
  // canonical journal's reader; a real one needs a verified directory this file does not compose.
  test('hand-built: while a retained canonical pre-sign intent holds an available row, caller B is refused by the wallet queue guard and nothing is written', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    const { item } = await f.signedByPoolKey()
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    const intents = jest
      .spyOn(LevelCanonicalStampAttemptJournal.prototype, 'getIntents')
      .mockReturnValue([
        { members: [{ reservation: { id: 'r', index: 0 } }] } as never,
      ])
    await expect(applyWalletSyncItem(wallet, item)).rejects.toThrow(
      'Canonical pre-sign intent requires explicit correlation before ordinary pool operations',
    )
    // A native send is an ordinary pool operation too: it, and so its pass, never starts.
    await expect(f.sendFromMain()).rejects.toThrow(
      'Canonical pre-sign intent requires explicit correlation',
    )
    expect(putMany).not.toHaveBeenCalled()
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(wallet.getNativeOperations!()).toEqual([])
    intents.mockRestore()
    expect(await applyWalletSyncItem(wallet, item)).toEqual({
      affectedIndices: [0],
    })
  })

  // Contract test 31. On main there is no pass to wait for.
  test('close during the local pass waits for it, and nothing is written after close', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    const flush = jest.spyOn(LevelSubAccountPoolStore.prototype, 'flush')
    let release!: () => void
    let entered!: () => void
    const inPass = new Promise<void>(resolve => (entered = resolve))
    const gate = new Promise<void>(resolve => (release = resolve))
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    putMany.mockImplementationOnce(function (
      this: LevelSubAccountPoolStore,
      records,
    ) {
      // The commit's own put: hold its flush open.
      flush.mockImplementationOnce(async function (
        this: LevelSubAccountPoolStore,
      ) {
        entered()
        await gate
        return LevelSubAccountPoolStore.prototype.flush.call(this)
      })
      putMany.mockRestore()
      return LevelSubAccountPoolStore.prototype.putMany.call(this, records)
    })
    const send = settled(f.sendFromPool())
    await inPass
    let closed = false
    const closing = wallet.close().then(() => {
      closed = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    release()
    // A wallet that is closing skips the transport step, so the send returns its result.
    expect(await send).toMatchObject({ value: { totalValueSent: 100000n } })
    await closing
    flush.mockRestore()
    const after = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    await new Promise(resolve => setImmediate(resolve))
    expect(after).not.toHaveBeenCalled()
    after.mockRestore()
    const second = await f.open()
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    expect(second.wallet.pool.getRecord(0)).toEqual(
      spentByMember(second.wallet.getNativeOperations!()[0]!),
    )
  })

  // The durable step is one pool row. Each way it can go wrong, with a real reopen. On main
  // nothing is written at all, so neither fault can occur and the row is never `spent`.
  test.each(['the write is lost', 'the write lands and an error is reported'] as const)(
    'when %s the send keeps its own outcome, the session signs nothing more, and after a real reopen the wallet is ready with a row it can finish or already has',
    async fault => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      const db = (
        wallet.pool as unknown as {
          store: { db: { batch: (...args: unknown[]) => Promise<unknown> } }
        }
      ).store.db
      const original = db.batch.bind(db)
      const batch = jest.spyOn(db, 'batch').mockImplementationOnce(async (...args) => {
        if (fault === 'the write lands and an error is reported')
          await original(...args)
        throw new Error('fixture: pool write fault')
      })
      const sent = await settled(f.sendFromPool())
      expect(batch).toHaveBeenCalledTimes(1)
      // The send's own outcome: included, and pending because this session has no local record
      // of the member (no note is transported either way).
      expect(sent.error).toBeInstanceOf(EvmNativeOperationPendingError)
      const operation = wallet.getNativeOperations!()[0]!
      expect(operation.members[0]!.observation.state).toBe('included-success')
      expect(
        (sent.error as EvmNativeOperationPendingError).transaction.txHash,
      ).toBe(operation.members[0]!.signed!.transactionHash)
      // The member has no local record this session, so it was never handed to transport.
      expect(f.transport).not.toHaveBeenCalled()
      expect(await f.admission()).toMatchObject({
        status: 'unavailable',
        reason: 'uncertain-owner',
      })
      const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
      await expect(f.sendFromMain()).rejects.toThrow('uncertain-owner')
      expect(sign).not.toHaveBeenCalled()
      await wallet.close()
      const second = await f.open()
      expect(await second.admission()).toMatchObject({ status: 'ready' })
      expectNoSpendRecordWithoutItsTransaction(second.wallet)
      // Stage 2 of #1235 changed the `write is lost` half of this on purpose: the row used to be
      // `available` (and reserved) after the reopen, until the next native send's pass finished
      // it. The reopen itself now applies the recorded member, so both faults converge here.
      expect(second.wallet.pool.isSpendReserved(0)).toBe(true)
      expect(second.wallet.pool.selectForStamp()).toBeUndefined()
      expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
      expect(await second.admission()).toMatchObject({ status: 'ready' })
      await second.wallet.close()
      const third = await f.open()
      expect(await third.admission()).toMatchObject({ status: 'ready' })
      expect(third.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    },
  )

  // Contract test 30: the bot and CLI shape. A guard: it passes on main, where no pool has an
  // applier, and must keep passing now that the composed wallet has one.
  test('guard: a pool from openMonadWalletBundle has no applier and still refuses a complete item', async () => {
    const bundleModule = jest.requireActual(
      '../storage/monad-wallet-bundle',
    ) as typeof import('../storage/monad-wallet-bundle')
    const mnemonic = 'test test test test test test test test test test test junk'
    const bundle = await bundleModule.openMonadWalletBundle({
      location: join(dir, 'bot'),
      seed: { mnemonic },
      mode: 'create',
    })
    try {
      bundle.pool.ensureSize(2)
      await bundle.pool.flush()
      const row = bundle.pool.getRecord(0)!
      const { MonadHdKeyring } = jest.requireActual<
        typeof import('../monad-hd-keyring')
      >('../monad-hd-keyring')
      const rawTx = await new Wallet(
        MonadHdKeyring.fromMnemonic(mnemonic).deriveSubAccount(0).privateKey,
      ).signTransaction({
        type: 2,
        chainId: 10143,
        nonce: 0,
        to: expected[1].main,
        value: 5n,
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
      const tx = Transaction.from(rawTx)
      expect(tx.from).toBe(row.address)
      const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
      await expect(
        applyWalletSyncItem(
          { chainIdentifier: 'monad-testnet', pool: bundle.pool },
          {
            type: 'wallet-sync',
            direction: 'out',
            chainIdentifier: 'monad-testnet',
            txHash: tx.hash!,
            rawTx,
            spentInputs: [{ address: row.address, nonce: 0, valueWei: '5' }],
            timestamp: 1,
          },
        ),
      ).rejects.toMatchObject({ code: 'no-applier', index: 0 })
      expect(putMany).not.toHaveBeenCalled()
      expect(bundle.pool.getRecord(0)).toEqual(row)
    } finally {
      await bundle.close()
    }
  })
})

/** Stage R of #1235. Row 0 is funded through the pool's own on-demand burn-account path with
 * exactly one 100000 wei burn of capacity, then out-holds main, so a native send selects it as
 * its source. `pending`: the broadcast reply is lost, so the member is signed and exposed but
 * unobserved. `included`: the transaction is mined, and inclusion is observed only by a fee
 * estimate, so nothing has recorded the row as spent. */
const reservationWallets: EvmChainWalletHandle[] = []
async function nativeSendFromProductionFundedPoolRow(
  dir: string,
  window: 'pending' | 'included',
) {
  const bundleModule = jest.requireActual(
    '../storage/monad-wallet-bundle',
  ) as typeof import('../storage/monad-wallet-bundle')
  const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
  const opened: Array<Awaited<ReturnType<typeof originalOpen>>> = []
  jest
    .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
    .mockImplementation(async params => {
      const result = await originalOpen(params)
      opened.push(result)
      return result
    })
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  const main = expected[0].main.toLowerCase()
  const poolAddress = expected[0].pool.toLowerCase()
  const ActualSigner = jest.requireActual<typeof import('../monad-account-tx')>(
    '../monad-account-tx',
  ).MonadAccountTxSigner
  const open = async (
    balances: Record<string, bigint>,
    nonces: Record<string, number> = {},
  ) => {
    const wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    reservationWallets.push(wallet)
    const bundle = opened[opened.length - 1]!
    const rpc = mockNativeRpc(wallet, balances, nonces)
    jest
      .spyOn(wallet.provider, 'getNetwork')
      .mockResolvedValue(Network.from(10143))
    const funder = new ActualSigner({
      privateKey: expected[0].mainSecret,
      provider: wallet.provider,
      httpClient: {
        submitRawTransaction: async (raw: string) => {
          const tx = Transaction.from(raw)
          await wallet.provider.broadcastTransaction(raw)
          const to = tx.to!.toLowerCase()
          rpc.balances.set(to, (rpc.balances.get(to) ?? 0n) + tx.value)
          return tx.hash!
        },
        getTransactionReceipt: async (txHash: string) =>
          ({ txHash, status: 'success' } as never),
      },
    })
    return {
      wallet,
      rpc,
      admission: () =>
        bundle.runLifetime(lifetime =>
          Promise.resolve(bundle.inputAdmission.inspect(lifetime)),
        ),
      /** The pool's on-demand preparation of one account able to burn exactly 100000 wei. */
      prepareBurn: () =>
        wallet.pool.prepareBurnAccount({
          mainAccountSigner: funder,
          provider: wallet.provider,
          burnValueWei: 100000n,
          gasReserveWei: 21000n,
          fundingOverrides: {
            chainId: 10143n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          },
        }),
      /** Senders of everything handed to the RPC since the last clear. */
      broadcastSenders: () =>
        rpc.broadcast.mock.calls.map(([raw]) =>
          Transaction.from(raw).from!.toLowerCase(),
        ),
    }
  }
  const first = await open({ [main]: 1000000n })
  const { wallet, rpc } = first
  expect(await first.prepareBurn()).toMatchObject({ index: 0 })
  expect(wallet.pool.getRecord(0)).toEqual({
    index: 0,
    address: expected[0].pool,
    status: 'available',
  })
  expect(rpc.balances.get(poolAddress)).toBe(121000n)
  // Main can no longer cover the send; the pool account can, with 50000 wei left over.
  rpc.balances.set(main, 40000n)
  rpc.broadcast.mockClear()
  const send = () =>
    wallet.sendNative({ recipient: { raw: expected[1].main }, value: 50000n })
  if (window === 'pending') {
    rpc.broadcast.mockRejectedValueOnce(new Error('reply lost'))
    await expect(send()).rejects.toThrow()
  } else {
    await send()
    expect(
      wallet.getNativeOperations!()[0]!.members[0]!.observation.state,
    ).toBe('missing')
    await wallet.estimateLegacyFee!({
      recipient: { raw: expected[1].main },
      value: 1n,
    })
  }
  const operation = wallet.getNativeOperations!()[0]!
  const member = operation.members[0]!
  expect(member.source).toEqual({ kind: 'spend', address: poolAddress, index: 0 })
  expect(member.exposed).toBe(true)
  expect(member.observation.state).toBe(
    // `missing`: looked for once, before the broadcast whose reply was lost.
    window === 'pending' ? 'missing' : 'included-success',
  )
  expect(member.syncApplied).toBe(false)
  expect(rpc.balances.get(poolAddress)).toBe(
    window === 'pending' ? 121000n : 50000n,
  )
  return { ...first, open, operation, member, main, poolAddress }
}

describe.each(['pending', 'included'] as const)(
  'a pool account a %s native send spends from is reserved (#1235)',
  window => {
    let dir: string
    let wallet: EvmChainWalletHandle
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'frank-1235-reservation-'))
    })
    afterEach(async () => {
      for (const opened of reservationWallets.splice(0)) await opened.close()
      await rm(dir, { recursive: true, force: true })
    })

    test('it is not offered as funded capacity, not leased and not reused or funded for a burn, which funds another account', async () => {
      const f = await nativeSendFromProductionFundedPoolRow(dir, window)
      wallet = f.wallet
      // The window: the native member exists and nothing has recorded the row as spent.
      expect(wallet.pool.getRecord(0)!.status).toBe('available')
      expect(wallet.pool.isSpendReserved(0)).toBe(true)
      expect(wallet.pool.isSpendReserved(1)).toBe(false)
      expect(await f.admission()).toMatchObject({ status: 'ready' })

      expect(await wallet.pool.fundedCapacities(wallet.provider, 21000n)).toEqual(
        [],
      )
      expect(wallet.pool.selectForStamp()).toBeUndefined()
      expect(() => wallet.leaseManager.acquireLease()).toThrow(
        NoAvailableSubAccountError,
      )
      expect(wallet.pool.getRecord(0)!.status).toBe('available')

      // On-demand preparation of the same burn the account was funded for: it funds row 1.
      f.rpc.balances.set(f.main, 1000000n)
      f.rpc.broadcast.mockClear()
      expect(await f.prepareBurn()).toMatchObject({ index: 1 })
      expect(f.broadcastSenders()).toEqual([f.main])
      expect(
        Transaction.from(f.rpc.broadcast.mock.calls[0]![0]).to!.toLowerCase(),
      ).toBe(wallet.pool.getRecord(1)!.address.toLowerCase())
      expect(wallet.pool.getRecord(1)!.status).toBe('available')
      // The reserved row is left to the native operation that spends from it: preparation neither
      // funds it nor writes a terminal status over it.
      expect(wallet.pool.getRecord(0)!.status).toBe('available')
      // The fresh account is ordinary inventory; the reserved one never comes back.
      expect(
        (await wallet.pool.fundedCapacities(wallet.provider, 21000n)).map(
          account => account.index,
        ),
      ).toEqual([1])
      expect(wallet.leaseManager.acquireLease().index).toBe(1)
      expect(await f.admission()).toMatchObject({ status: 'ready' })
      expect(wallet.getNativeOperations!()).toEqual([f.operation])
    })

    test('the reservation is derived from the journal again after close and reopen', async () => {
      const f = await nativeSendFromProductionFundedPoolRow(dir, window)
      wallet = f.wallet
      const balances = Object.fromEntries(f.rpc.balances)
      await wallet.close()
      const second = await f.open(
        { ...balances, [f.main]: 1000000n },
        window === 'included' ? { [f.poolAddress]: 1, [f.main]: 1 } : { [f.main]: 1 },
      )
      wallet = second.wallet
      expect(wallet.getNativeOperations!()).toEqual([f.operation])
      // Stage 2 of #1235 changed the `included` half of this assertion on purpose: the row was
      // pinned `available` after the reopen, because nothing applied recorded evidence at open.
      // Open now records it; the reservation below is still read from the journal either way.
      expect(wallet.pool.getRecord(0)).toEqual(
        window === 'included'
          ? {
              index: 0,
              address: expected[0].pool,
              status: 'spent',
              lifecycle: {
                spend: {
                  rawTx: f.member.signed!.rawTransaction,
                  txHash: f.member.signed!.transactionHash,
                  valueWei: '50000',
                },
              },
            }
          : { index: 0, address: expected[0].pool, status: 'available' },
      )
      expect(wallet.pool.capacityCache.size).toBe(0)
      expect(wallet.pool.isSpendReserved(0)).toBe(true)
      expect(await second.admission()).toMatchObject({ status: 'ready' })
      expect(await wallet.pool.fundedCapacities(wallet.provider, 21000n)).toEqual(
        [],
      )
      expect(wallet.pool.selectForStamp()).toBeUndefined()
      expect(() => wallet.leaseManager.acquireLease()).toThrow(
        NoAvailableSubAccountError,
      )
      expect(await second.prepareBurn()).toMatchObject({ index: 1 })
      expect(second.broadcastSenders()).toEqual([f.main])
      expect(await second.admission()).toMatchObject({ status: 'ready' })
    })

    test(
      window === 'pending'
        ? 'pins: another native send cannot plan or sign from the account while the first is unresolved'
        : 'a later native send still spends the residual at the next nonce, and the account stays out of other selection',
      async () => {
        const f = await nativeSendFromProductionFundedPoolRow(dir, window)
        wallet = f.wallet
        const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
        f.rpc.broadcast.mockClear()
        // More than main (40000) can pay with its fee; within what the pool account holds (pending:
        // 121000) or keeps as a residual (included: 50000).
        const again = wallet.sendNative({
          recipient: { raw: expected[1].main },
          value: window === 'pending' ? 45000n : 25000n,
        })
        if (window === 'pending') {
          await expect(again).rejects.toThrow(
            'Insufficient unreserved native funds',
          )
          expect(sign).not.toHaveBeenCalled()
          expect(f.rpc.broadcast).not.toHaveBeenCalled()
          expect(wallet.getNativeOperations!()).toEqual([f.operation])
        } else {
          await again
          const residual = Transaction.from(f.rpc.broadcast.mock.calls[0]![0])
          expect(residual.from!.toLowerCase()).toBe(f.poolAddress)
          expect(residual.nonce).toBe(1)
          expect(wallet.pool.getRecord(0)!.status).toBe('available')
          expect(
            await wallet.pool.fundedCapacities(wallet.provider, 21000n),
          ).toEqual([])
          expect(wallet.pool.selectForStamp()).toBeUndefined()
        }
        expect(await f.admission()).toMatchObject({ status: 'ready' })
      },
    )
  },
)

// The background funder that ran after every spend, broadcasting with no record, is deleted
// (#1235 Q4). Pin: a spent or retired account starts no funding by itself.
test('retiring a pool account on a normally opened wallet builds and submits no transfer (#1235)', async () => {
  const built = jest.fn(async () => ({
    rawTx: '0x1234',
    txHash: '0x' + 'ab'.repeat(32),
  }))
  const submitted = jest.fn(async () => '0x' + 'ab'.repeat(32))
  jest
    .mocked(MonadAccountTxSigner)
    .mockImplementation(
      () => ({ buildAndSignTransfer: built, submit: submitted } as never),
    )
  const dir = await mkdtemp(join(tmpdir(), 'frank-no-funding-after-spend-'))
  const wallet = (await createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    jest.spyOn(wallet.provider, 'getBalance').mockResolvedValue(0n)
    jest.mocked(MonadAccountTxSigner).mockClear()
    wallet.pool.setStatus(0, 'in-use')
    wallet.pool.setStatus(0, 'retired')
    wallet.pool.setStatus(1, 'in-use')
    wallet.pool.setStatus(1, 'spent')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(jest.mocked(MonadAccountTxSigner)).not.toHaveBeenCalled()
    expect(built).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
    expect(
      wallet.pool.records().filter(row => row.status === 'funding'),
    ).toEqual([])
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// #1235 Q4. `fundAhead` does not exist on main 8c656f32.
test('fundAhead answers unavailable, having built nothing, for a wallet with no canonical sender accounts, and rejects once it is closed', async () => {
  const chain = createEvmChain(config)
  const wallet = await chain.createWallet(roots())
  try {
    jest.mocked(MonadAccountTxSigner).mockClear()
    const read = jest.spyOn(
      (wallet as EvmChainWalletHandle).provider,
      'getBalance',
    )
    await expect(chain.directMessages.fundAhead!({ wallet })).resolves.toEqual({
      outcome: 'unavailable',
      fundingTxHashes: [],
    })
    expect(jest.mocked(MonadAccountTxSigner)).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  } finally {
    await wallet.close()
  }
  await expect(chain.directMessages.fundAhead!({ wallet })).rejects.toThrow(
    'closed',
  )
})

test('close drains an admitted plan that has not reached signing yet', async () => {
  const wallet = (await createEvmChain(config).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  const rpc = mockNativeRpc(wallet, { [expected[0].main]: 100000n })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const wait = new Promise<void>(resolve => {
    release = resolve
  })
  jest.spyOn(wallet.provider, 'getFeeData').mockImplementation(async () => {
    entered()
    await wait
    return { gasPrice: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as never
  })
  try {
    const send = wallet.sendNative({
      recipient: { raw: expected[1].main },
      value: 1000n,
    })
    await started
    const close = wallet.close()
    expect(rpc.broadcast).not.toHaveBeenCalled()
    release()
    await expect(send).resolves.toHaveProperty('txHash')
    await close
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
  } finally {
    release?.()
    await wallet.close()
  }
})

test('conflicting recovered owners remain read-only, and reopening builds and submits nothing', async () => {
  const bundleModule = jest.requireActual(
    '../storage/monad-wallet-bundle',
  ) as typeof import('../storage/monad-wallet-bundle')
  const originalOpen = bundleModule.openExistingPoolMonadTopicOwner
  let lastBundle: Awaited<ReturnType<typeof originalOpen>> | undefined
  jest
    .spyOn(bundleModule, 'openExistingPoolMonadTopicOwner')
    .mockImplementation(async params => {
      const result = await originalOpen(params)
      lastBundle = result
      return result
    })
  const dir = await mkdtemp(join(tmpdir(), 'frank-stage-a-conflict-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  let wallet: EvmChainWalletHandle | undefined
  try {
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    mockNativeRpc(wallet, { [expected[0].main]: 500000n })
    // #1235 Stage C changed this fixture on purpose. It used to fail the signature and rely on
    // the never-signed plan staying in the journal, uncancelled, to conflict with the funding
    // attempt below. Such a plan is now cancelled by its own failed send (and at open), so that
    // conflict no longer exists. The subject here is a conflict that must persist, so the
    // native member is signed and never exposed: a signed member is never cancelled.
    await expect(
      wallet.sendNative({
        recipient: { raw: expected[1].main },
        value: 1n,
        onSigned: async () => {
          throw new Error('fixture signed, never exposed')
        },
      }),
    ).rejects.toThrow('fixture signed, never exposed')
    const nativeBefore = wallet.getNativeOperations!()
    expect(nativeBefore).toHaveLength(1)
    expect(nativeBefore[0].cancelled).toBe(false)
    expect(nativeBefore[0].members[0]!.signed).not.toBeNull()
    expect(nativeBefore[0].members[0]!.exposed).toBe(false)
    jest
      .spyOn(wallet.provider, 'getNetwork')
      .mockResolvedValue(Network.from(10143))
    const ActualSigner = jest.requireActual(
      '../monad-account-tx',
    ).MonadAccountTxSigner
    const signer = new ActualSigner({
      privateKey: expected[0].mainSecret,
      provider: wallet.provider,
      httpClient: {
        submitRawTransaction: async (raw: string) => keccak256(raw),
        getTransactionReceipt: async () => undefined,
      },
    })
    await expect(
      wallet.pool.topUpPool({
        mainAccountSigner: signer,
        burnValue: 1000n,
        gasReserve: 21000n,
        bufferSize: 1,
        overrides: {
          nonce: 0,
          chainId: 10143n,
          gasLimit: 21000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        },
        receipt: { maxAttempts: 0 },
      }),
    ).rejects.toThrow('still pending')
    const held = wallet.pool.records().find(row => row.status === 'funding')!
    expect(held).toBeDefined()
    expect(Transaction.from(held.fundingAttempt!.rawTx).nonce).toBe(0)
    await wallet.close()
    wallet = undefined
    const built = jest.fn(async () => ({
      rawTx: '0x1234',
      txHash: '0x' + 'ab'.repeat(32),
    }))
    const submitted = jest.fn(async () => '0x' + 'ab'.repeat(32))
    jest
      .mocked(MonadAccountTxSigner)
      .mockImplementation(
        () => ({ buildAndSignTransfer: built, submit: submitted } as never),
      )
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    await new Promise<void>(resolve => setImmediate(resolve))
    const snapshot = await lastBundle!.runLifetime(lifetime =>
      Promise.resolve(lastBundle!.inputAdmission.inspect(lifetime)),
    )
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      reason: 'conflicting-authorization',
    })
    expect(wallet.getNativeOperations!()).toEqual(nativeBefore)
    expect(wallet.pool.records().find(row => row.index === held.index)).toEqual(
      held,
    )
    expect(built).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
  } finally {
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------------------------------------
// Stage C of #1235: a native plan that never signed is cancelled, by the send that failed and at
// wallet open. Composed, file-backed wallets with real reopens. Each test names what it
// reproduces on main e8d87c2d, or says it is a pin.
// -------------------------------------------------------------------------------------------
describe('a native plan that never signed is cancelled (#1235 Stage C)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frank-1235-stage-c-'))
  })
  afterEach(async () => {
    for (const opened of spendRecordWallets.splice(0))
      await opened.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })
  type Composed = Awaited<ReturnType<typeof composedWithProductionFundedPoolRow>>
  const recipient = expected[1].main
  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value): { value?: T; error?: unknown } => ({ value }),
      (error: unknown): { value?: T; error?: unknown } => ({ error }),
    )
  /** A plan written the way a crash between the journal write and the first signature leaves
   * it: admitted and journalled by the real admission, with no send and no signature. */
  const crashedPlan = (
    f: Pick<Composed, 'bundle'>,
    source:
      | { kind: 'main'; address: string }
      | { kind: 'spend'; address: string; index: number },
    nonce: number,
    value = 1000n,
  ) =>
    f.bundle.runLifetime(async lifetime => {
      const current = f.bundle.inputAdmission.inspect(lifetime)
      if (current.status !== 'ready') throw new Error(current.reason)
      return f.bundle.inputAdmission.prepareNative(lifetime, current.epoch, {
        kind: 'native',
        recipient: recipient.toLowerCase(),
        intendedValueWei: value.toString(),
        members: [
          {
            source,
            dependencies: [],
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: 10143n,
              nonce,
              to: recipient,
              value,
              gasLimit: 21000n,
              maxFeePerGas: 1n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
          },
        ],
      })
    })
  /** Everything that could reach the network or a key, counted from now on. */
  const watchNetworkAndKeys = () => {
    const watched = {
      fetch: jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network touched')),
      // The modules themselves: an import namespace cannot be spied on.
      httpRequest: jest.spyOn(
        jest.requireActual<typeof import('http')>('http'),
        'request',
      ),
      httpsRequest: jest.spyOn(
        jest.requireActual<typeof import('https')>('https'),
        'request',
      ),
      rpcSend: jest.spyOn(JsonRpcProvider.prototype, 'send'),
      rpcTransport: jest.spyOn(FetchRequest.prototype, 'send'),
      relaySubmit: jest.spyOn(MonadHttpClient.prototype, 'submitRawTransaction'),
      relayReceipt: jest.spyOn(
        MonadHttpClient.prototype,
        'getTransactionReceipt',
      ),
      relayLogs: jest.spyOn(MonadHttpClient.prototype, 'getLogs'),
      relayBlock: jest.spyOn(MonadHttpClient.prototype, 'getBlockNumber'),
      accountSigner: jest.mocked(MonadAccountTxSigner),
      signTransaction: jest.spyOn(Wallet.prototype, 'signTransaction'),
      signDigest: jest.spyOn(SigningKey.prototype, 'sign'),
    }
    watched.accountSigner.mockClear()
    return () =>
      Object.fromEntries(
        Object.entries(watched).map(([name, spy]) => [
          name,
          spy.mock.calls.length,
        ]),
      )
  }
  const untouched = {
    fetch: 0,
    httpRequest: 0,
    httpsRequest: 0,
    rpcSend: 0,
    rpcTransport: 0,
    relaySubmit: 0,
    relayReceipt: 0,
    relayLogs: 0,
    relayBlock: 0,
    accountSigner: 0,
    signTransaction: 0,
    signDigest: 0,
  }

  // Acceptance case 1 (and 5). On main e8d87c2d the plan stays in the journal unsigned and
  // uncancelled, `canSelect` refuses main, and the second send fails with
  // "Insufficient unreserved native funds".
  test('signing throws for a main-sourced sendNative: the send throws its own error, the plan is cancelled in that call and retained, and a second sendNative from main succeeds', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    // Only main holds anything: there is no other account a later send could fall back on.
    f.rpc.balances.set(f.poolAddress, 0n)
    f.rpc.balances.set(f.main, 500000n)
    const sign = jest
      .spyOn(Wallet.prototype, 'signTransaction')
      .mockRejectedValueOnce(new Error('fixture: signer unavailable'))
    const failed = await outcome(
      wallet.sendNative({ recipient: { raw: recipient }, value: 1000n }),
    )
    sign.mockRestore()
    expect(failed.error).toBeInstanceOf(Error)
    expect((failed.error as Error).message).toBe('fixture: signer unavailable')
    // The state the failing call left, read before anything else runs.
    const [plan] = wallet.getNativeOperations!()
    const afterFailure = await f.admission()
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
    // Asked first, so that main e8d87c2d fails here with its own refusal.
    const second = await wallet.sendNative({
      recipient: { raw: recipient },
      value: 1000n,
    })
    expect(plan).toMatchObject({
      cancelled: true,
      intendedValueWei: '1000',
      members: [
        { source: { kind: 'main', address: f.main }, signed: null, exposed: false },
      ],
    })
    expect(afterFailure).toMatchObject({ status: 'ready', obligations: [] })
    const operations = wallet.getNativeOperations!()
    expect(operations).toHaveLength(2)
    // Retained, not deleted, and untouched by the send that followed.
    expect(operations[0]).toEqual(plan)
    expect(second).toEqual({
      txHash: operations[1]!.members[0]!.signed!.transactionHash,
    })
    expect(f.rpc.broadcast).toHaveBeenCalledTimes(1)
    const sent = Transaction.from(f.rpc.broadcast.mock.calls[0]![0])
    expect(sent.from).toBe(expected[0].main)
    // The cancelled plan's nonce was never consumed: the second send uses it.
    expect(sent.nonce).toBe(Transaction.from(plan!.members[0]!.unsignedTransaction).nonce)
    await wallet.close()
    const reopened = await f.open()
    expect(reopened.wallet.getNativeOperations!()[0]).toEqual(plan)
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
  })

  // Acceptance case 2 (and 5). On main e8d87c2d the pool account stays reserved for good:
  // `isSpendReserved(0)` is true, in this session and after every reopen.
  test('signing throws for a pool-sourced send: the plan is cancelled in that call, the pool account is no longer reserved, and it is spent by the next send', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    const sign = jest
      .spyOn(Wallet.prototype, 'signTransaction')
      .mockRejectedValueOnce(new Error('fixture: signer unavailable'))
    const failed = await outcome(f.sendFromPool())
    sign.mockRestore()
    expect((failed.error as Error).message).toBe('fixture: signer unavailable')
    const [plan] = wallet.getNativeOperations!()
    expect(plan).toMatchObject({
      cancelled: true,
      members: [
        {
          source: { kind: 'spend', index: 0, address: f.poolAddress },
          signed: null,
          exposed: false,
        },
      ],
    })
    expect(wallet.pool.isSpendReserved(0)).toBe(false)
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(wallet.pool.selectForStamp()).toMatchObject({ index: 0 })
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
    await wallet.close()
    const reopened = await f.open()
    expect(reopened.wallet.pool.isSpendReserved(0)).toBe(false)
    expect(reopened.wallet.getNativeOperations!()).toEqual([plan])
    // The same send again, from the same account at the same nonce.
    reopened.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    await reopened.sendFromPool()
    const [, next] = reopened.wallet.getNativeOperations!()
    expect(next!.members[0]!.source).toEqual(plan!.members[0]!.source)
    expect(reopened.wallet.pool.getRecord(0)).toEqual(spentByMember(next!))
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
  })

  // Acceptance cases 3 and 5. On main e8d87c2d both plans survive the reopen uncancelled, the
  // pool account stays reserved, and the send from main fails with
  // "Insufficient unreserved native funds".
  test('a crash between the journal write and signing, then reopen: both plans are cancelled at open with no provider, relay or signer call, retained, and main is selectable again', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const mainPlan = await crashedPlan(
      f,
      { kind: 'main', address: f.main },
      f.rpc.nonces.get(f.main) ?? 0,
    )
    const poolPlan = await crashedPlan(
      f,
      { kind: 'spend', address: f.poolAddress, index: 0 },
      0,
    )
    expect(f.wallet.getNativeOperations!()).toEqual([mainPlan, poolPlan])
    expect(f.wallet.pool.isSpendReserved(0)).toBe(true)
    await f.wallet.close()
    const counts = watchNetworkAndKeys()
    const cancel = jest.spyOn(
      EvmNativeOperationJournal.prototype,
      'cancelUnsigned',
    )
    const reopened = await f.open()
    // The whole open, the cancel included, touched no network and no key.
    expect(counts()).toEqual(untouched)
    expect(reopened.wallet.provider).toBeInstanceOf(JsonRpcProvider)
    jest.mocked(globalThis.fetch).mockRestore()
    expect(cancel.mock.calls.map(([id]) => id)).toEqual([
      mainPlan.operationId,
      poolPlan.operationId,
    ])
    expect(reopened.wallet.getNativeOperations!()).toEqual([
      { ...mainPlan, cancelled: true },
      { ...poolPlan, cancelled: true },
    ])
    expect(reopened.wallet.pool.isSpendReserved(0)).toBe(false)
    expect(reopened.wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(await reopened.admission()).toMatchObject({
      status: 'ready',
      obligations: [],
    })
    // Only main can pay for this one.
    reopened.rpc.balances.set(f.poolAddress, 0n)
    reopened.rpc.broadcast.mockClear()
    await reopened.sendFromMain()
    expect(Transaction.from(reopened.rpc.broadcast.mock.calls[0]![0]).from).toBe(
      expected[0].main,
    )
    // A second open has nothing left to cancel.
    await reopened.wallet.close()
    cancel.mockClear()
    const again = await f.open()
    expect(cancel).not.toHaveBeenCalled()
    expect(again.wallet.getNativeOperations!().slice(0, 2)).toEqual([
      { ...mainPlan, cancelled: true },
      { ...poolPlan, cancelled: true },
    ])
  })

  // On main e8d87c2d no cancel is attempted at open at all (the first assertion on `cancel`).
  test('an open-time cancel that fails does not fail the open: the wallet opens with the plan as it was, and the next open cancels it', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const plan = await crashedPlan(
      f,
      { kind: 'main', address: f.main },
      f.rpc.nonces.get(f.main) ?? 0,
    )
    await f.wallet.close()
    const cancel = jest
      .spyOn(EvmNativeOperationJournal.prototype, 'cancelUnsigned')
      .mockRejectedValue(new Error('fixture: cancel failed'))
    const warned = jest.spyOn(console, 'warn')
    const errored = jest.spyOn(console, 'error')
    const reopened = await f.open()
    expect(cancel).toHaveBeenCalledTimes(1)
    // Quiet: nothing is logged for it.
    expect(warned).not.toHaveBeenCalled()
    expect(errored).not.toHaveBeenCalled()
    expect(reopened.wallet.getNativeOperations!()).toEqual([plan])
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
    await reopened.wallet.close()
    cancel.mockRestore()
    const again = await f.open()
    expect(again.wallet.getNativeOperations!()).toEqual([
      { ...plan, cancelled: true },
    ])
  })

  // Acceptance case 4. Pin of the limit: main e8d87c2d does not cancel it either. What stays
  // frozen here is the subject of #1230.
  test('pin: a fan-in with its first member signed and its drain unsigned is not cancelled, by the failing send or at open; its accounts stay claimed', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    // Neither account covers 150000 alone: the pool account leads, main feeds it.
    f.rpc.balances.set(f.main, 80000n)
    const real = Wallet.prototype.signTransaction
    let signatures = 0
    const sign = jest
      .spyOn(Wallet.prototype, 'signTransaction')
      .mockImplementation(function (this: Wallet, tx) {
        return ++signatures === 2
          ? Promise.reject(new Error('fixture: second signature refused'))
          : real.call(this, tx)
      })
    const failed = await outcome(
      wallet.sendLegacy!({ recipient: { raw: recipient }, value: 150000n }),
    )
    sign.mockRestore()
    expect((failed.error as Error).message).toBe(
      'fixture: second signature refused',
    )
    const [partial] = wallet.getNativeOperations!()
    expect(partial!.members.map(m => [m.source.kind, m.signed !== null])).toEqual(
      [
        ['main', true],
        ['spend', false],
      ],
    )
    expect(partial!.cancelled).toBe(false)
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
    await wallet.close()
    const cancel = jest.spyOn(
      EvmNativeOperationJournal.prototype,
      'cancelUnsigned',
    )
    const reopened = await f.open()
    expect(cancel).not.toHaveBeenCalled()
    expect(reopened.wallet.getNativeOperations!()).toEqual([partial])
    expect(reopened.wallet.pool.isSpendReserved(0)).toBe(true)
    await expect(
      reopened.wallet.cancelUnsignedNativeOperation!(partial!.operationId),
    ).rejects.toThrow('conflict')
    reopened.rpc.balances.set(f.main, 500000n)
    await expect(
      reopened.wallet.sendNative({ recipient: { raw: recipient }, value: 1000n }),
    ).rejects.toThrow('Insufficient unreserved native funds')
    expect(reopened.wallet.getNativeOperations!()).toHaveLength(1)
  })

  // Coordinator item 7. On main e8d87c2d: the send below is refused the same way, but its
  // never-signed plan stays, the admission is `conflicting-authorization` from then on (in the
  // session and after every reopen), and no later send of any kind is admitted.
  test('a pool row spent by a transaction no native member owns, then a native plan from it at the next nonce: the send is refused, its plan is cancelled, and the admission is ready again; the same at open', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    // What a paid message leaves: the account's own key spent part of it at nonce 0, recorded on
    // the row through the real applier, with no native journal member. A residual remains.
    const { rawTx, item } = await f.signedByPoolKey({ value: 1000n })
    await applyWalletSyncItem(wallet, item)
    expect(wallet.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx } },
    })
    f.rpc.nonces.set(f.poolAddress, 1)
    f.rpc.balances.set(f.poolAddress, 99000n)
    expect(await f.admission()).toMatchObject({ status: 'ready' })
    // Only the residual covers this (main holds 40000): a native plan from the row at nonce 1.
    const residualSend = () =>
      outcome(
        wallet.sendLegacy!({ recipient: { raw: recipient }, value: 60000n }),
      )
    const refused = await residualSend()
    // The send's own error: the admission refuses to authorize the signature.
    expect(refused.error).toMatchObject({
      name: 'EvmInputAdmissionError',
      reason: 'conflicting-authorization',
    })
    const [plan] = wallet.getNativeOperations!()
    expect(plan).toMatchObject({
      cancelled: true,
      members: [
        {
          source: { kind: 'spend', index: 0, address: f.poolAddress },
          signed: null,
          exposed: false,
        },
      ],
    })
    expect(Transaction.from(plan!.members[0]!.unsignedTransaction).nonce).toBe(1)
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
    expect(await f.admission()).toMatchObject({ status: 'ready' })
    // The wallet is not stuck: a send main can cover is admitted, signed and broadcast.
    await f.sendFromMain()
    expect(f.rpc.broadcast).toHaveBeenCalledTimes(1)
    expect(Transaction.from(f.rpc.broadcast.mock.calls[0]![0]).from).toBe(
      expected[0].main,
    )
    // What remains: the residual itself is still unreachable. The same send is refused the
    // same way every time (and cancelled every time).
    f.rpc.balances.set(f.main, 40000n)
    const again = await residualSend()
    expect(again.error).toMatchObject({ reason: 'conflicting-authorization' })
    expect(wallet.getNativeOperations!().map(row => row.cancelled)).toEqual([
      true,
      false,
      true,
    ])
    expect(wallet.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx } },
    })
    expect(await f.admission()).toMatchObject({ status: 'ready' })
    // At open: the state main leaves on disk, a never-signed plan at the next nonce, uncancelled.
    const stuck = await crashedPlan(
      f,
      { kind: 'spend', address: f.poolAddress, index: 0 },
      1,
    )
    expect(await f.admission()).toMatchObject({
      status: 'unavailable',
      reason: 'conflicting-authorization',
    })
    await wallet.close()
    const reopened = await f.open()
    expect(reopened.wallet.getNativeOperations!()[3]).toEqual({
      ...stuck,
      cancelled: true,
    })
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
  })

  // Pin (contract 3.5): a committed row is not undone when a later observation regresses.
  test('pin: a member that regresses after its row was recorded keeps the row spent and the admission ready, also after a real reopen', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    await outcome(f.sendFromPool())
    const [included] = wallet.getNativeOperations!()
    const row = spentByMember(included!)
    expect(wallet.pool.getRecord(0)).toEqual(row)
    // The node no longer returns the receipt; a later send's planning looks again.
    f.withholdReceipts(true)
    await f.sendFromMain()
    const regressed = wallet.getNativeOperations!()[0]!
    expect(regressed.members[0]!.observation.state).toBe('pending')
    expect(wallet.pool.getRecord(0)).toEqual(row)
    expect(await f.admission()).toMatchObject({ status: 'ready' })
    await wallet.close()
    const reopened = await f.open()
    expect(await reopened.admission()).toMatchObject({ status: 'ready' })
    expect(reopened.wallet.pool.getRecord(0)).toEqual(row)
    expect(reopened.wallet.getNativeOperations!()[0]).toEqual(regressed)
    expect(reopened.wallet.pool.selectForStamp()).toBeUndefined()
  })
})

describe('recorded native spend evidence is applied once at wallet open, with no network (#1235 Stage 2)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frank-1235-stage-2-'))
  })
  afterEach(async () => {
    for (const opened of spendRecordWallets.splice(0))
      await opened.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })
  type Composed = Awaited<ReturnType<typeof composedWithProductionFundedPoolRow>>
  type Session = Awaited<ReturnType<Composed['open']>>
  const recipient = expected[1].main

  /**
   * Counts, from now on, every way an open could reach the network, a key or the transport step.
   *
   * The layer that counts is the JSON-RPC one. Both the wallet's provider and its relay HTTP
   * client are `JsonRpcProvider`s: every request either makes goes through `send`, then `_send`,
   * then `FetchRequest.send`. `FetchRequest.send` is replaced with a rejection, so nothing in
   * these tests can leave the process. `fetch` and `http(s).request` are watched too, but ethers
   * on node does not go through `fetch`, so a zero there proves little by itself: `control`
   * below is what shows these counters see a real provider request.
   */
  const watchOpen = () => {
    const touched = () => Promise.reject(new Error('fixture: network touched'))
    const created = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
    const relayClient = Object.getOwnPropertyNames(
      MonadHttpClient.prototype,
    ).filter(name => name !== 'constructor' && name !== 'destroy')
    const watched: Record<string, { mock: { calls: unknown[] } }> = {
      rpcSend: jest.spyOn(JsonRpcProvider.prototype, 'send'),
      rpcBatch: jest.spyOn(JsonRpcProvider.prototype, '_send'),
      rpcTransport: jest
        .spyOn(FetchRequest.prototype, 'send')
        .mockImplementation(touched),
      fetch: jest.spyOn(globalThis, 'fetch').mockImplementation(touched),
      httpRequest: jest.spyOn(
        jest.requireActual<typeof import('http')>('http'),
        'request',
      ),
      httpsRequest: jest.spyOn(
        jest.requireActual<typeof import('https')>('https'),
        'request',
      ),
      ...Object.fromEntries(
        relayClient.map(name => [
          `relayClient.${name}`,
          jest.spyOn(MonadHttpClient.prototype, name as 'getBlockNumber'),
        ]),
      ),
      accountSigner: jest.mocked(MonadAccountTxSigner),
      signTransaction: jest.spyOn(Wallet.prototype, 'signTransaction'),
      signDigest: jest.spyOn(SigningKey.prototype, 'sign'),
      // The transport step and what it would write, and any new observation.
      flushSync: jest.spyOn(EvmLegacyConsolidator.prototype, 'flushSync'),
      markSyncApplied: jest.spyOn(
        EvmNativeOperationJournal.prototype,
        'markSyncApplied',
      ),
      observe: jest.spyOn(EvmLegacyConsolidator.prototype, 'observe'),
      beginCapture: jest.spyOn(
        EvmNativeOperationJournal.prototype,
        'beginCapture',
      ),
      // Stage 3: open never starts a re-observation, whatever is pending in the journal.
      reobserve: jest.spyOn(EvmLegacyConsolidator.prototype, 'reobservePending'),
      // Q4: open never funds, ahead or otherwise. Only a host's explicit call does.
      fundAhead: jest.spyOn(
        MonadSubAccountPool.prototype,
        'fundStampInventoryAhead',
      ),
      prepareInventory: jest.spyOn(
        MonadSubAccountPool.prototype,
        'prepareStampInventory',
      ),
    }
    jest.mocked(MonadAccountTxSigner).mockClear()
    const counts = () =>
      Object.fromEntries(
        Object.entries(watched).map(([name, spy]) => [
          name,
          spy.mock.calls.length,
        ]),
      )
    const untouched = Object.fromEntries(
      Object.keys(watched).map(name => [name, 0]),
    )
    expect(relayClient.length).toBeGreaterThanOrEqual(4)
    return {
      counts,
      untouched,
      /** The positive control. One real, unmocked read on the provider the open built and one
       * on its relay client: each must be counted at all three JSON-RPC layers. */
      control: async (wallet: EvmChainWalletHandle) => {
        const [provider, relayProvider] = created.mock.results
          .slice(-2)
          .map(result => result.value)
        expect(wallet.provider).toBe(provider)
        expect(relayProvider).toBeInstanceOf(JsonRpcProvider)
        const before = counts()
        expect(before).toEqual(untouched)
        await expect(wallet.provider.getBlockNumber()).rejects.toThrow(
          'fixture: network touched',
        )
        const afterProvider = counts()
        expect(afterProvider).toEqual({
          ...untouched,
          rpcSend: 1,
          rpcBatch: 1,
          rpcTransport: 1,
        })
        await expect(wallet.httpClient.getBlockNumber()).rejects.toThrow()
        expect(counts()).toEqual({
          ...untouched,
          'relayClient.getBlockNumber': 1,
          rpcSend: 2,
          rpcBatch: 2,
          rpcTransport: 2,
        })
      },
    }
  }
  /** What the open did to durable state and to the pool's one spend writer. */
  const watchWrites = () => {
    const real = {
      cancel: EvmLegacyConsolidator.prototype.cancelUnsignedOperations,
      pass: EvmLegacyConsolidator.prototype.applyRecordedEvidence,
    }
    const spies = {
      pass: jest.spyOn(EvmLegacyConsolidator.prototype, 'applyRecordedEvidence'),
      cancel: jest.spyOn(
        EvmLegacyConsolidator.prototype,
        'cancelUnsignedOperations',
      ),
      commit: jest.spyOn(MonadSubAccountPool.prototype, 'commitSpend'),
      putMany: jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany'),
    }
    return {
      ...spies,
      real,
      counts: () => ({
        pass: spies.pass.mock.calls.length,
        commit: spies.commit.mock.calls.length,
        putMany: spies.putMany.mock.calls.length,
      }),
      clear: () => Object.values(spies).forEach(spy => spy.mockClear()),
    }
  }
  /**
   * The window a crash or a close leaves: a legacy send from pool account 0 that was pending in
   * its own call (so its own pass applied nothing), whose inclusion the journal then recorded
   * through a fee estimate, which observes and runs no pass. Built through the real wallet only.
   * `node` edits what the simulated node answers before that estimate looks.
   */
  const poolSendThenObserved = async (
    f: Composed,
    state: 'included-success' | 'included-revert' | 'missing' | 'pending',
  ) => {
    const { wallet } = f
    f.withholdReceipts(true)
    const sent = await settled(f.sendFromPool())
    expect(sent.error).toBeInstanceOf(EvmNativeOperationPendingError)
    const hash = wallet.getNativeOperations!().slice(-1)[0]!.members[0]!.signed!
      .transactionHash
    if (state === 'included-revert')
      (f.rpc.receipts.get(hash) as { status: number }).status = 0
    if (state === 'missing') {
      f.rpc.transactions.delete(hash)
      f.rpc.receipts.delete(hash)
    }
    if (state !== 'pending') {
      f.withholdReceipts(false)
      await wallet.estimateLegacyFee!({ recipient: { raw: recipient }, value: 1n })
    }
    const operations = wallet.getNativeOperations!()
    const operation = operations[operations.length - 1]!
    expect(operation.members[0]!.source).toEqual({
      kind: 'spend',
      address: f.poolAddress,
      index: 0,
    })
    expect(operation.members[0]!.observation.state).toBe(state)
    expect(operation.members[0]!.syncApplied).toBe(false)
    // Nothing recorded the row: it is reserved by the journal member and still `available`.
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(wallet.pool.isSpendReserved(0)).toBe(true)
    expect(f.transport).not.toHaveBeenCalled()
    return { operation, operations }
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))

  // Contract cases 1, 2 and 3. On main c32dd683 nothing applies recorded evidence at open: the
  // row is still `available` after the reopen (and the pass method does not exist).
  test('a pool-sourced send recorded included but never applied: reopen marks the row spent with the journal member\'s bytes, the whole open makes no request, signs nothing and transports nothing, a main-sourced member costs nothing, and a second reopen writes nothing', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    // A main-sourced native send first: its member is included too, and has no pool row.
    await f.sendFromMain()
    f.rpc.balances.set(f.main, 40000n)
    const { operation, operations } = await poolSendThenObserved(
      f,
      'included-success',
    )
    expect(operations.map(row => row.members[0]!.source.kind)).toEqual([
      'main',
      'spend',
    ])
    expect(operations.map(row => row.members[0]!.observation.state)).toEqual([
      'included-success',
      'included-success',
    ])
    await f.wallet.close()

    const network = watchOpen()
    const writes = watchWrites()
    const second = await f.open()
    // The entire open: no request at any JSON-RPC layer, no relay client call, no signature,
    // no observation, no transport step.
    expect(network.counts()).toEqual(network.untouched)
    await settle()
    expect(network.counts()).toEqual(network.untouched)
    expect(second.transport).not.toHaveBeenCalled()
    // One pass, one call of the writer, one durable put: the pool member. The main-sourced
    // member reached neither.
    expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })
    expect(writes.commit).toHaveBeenCalledWith(
      0,
      operation.members[0]!.signed!.rawTransaction,
    )
    expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    expectNoSpendRecordWithoutItsTransaction(second.wallet)
    // The journal is exactly as the last session left it.
    expect(second.wallet.getNativeOperations!()).toEqual(operations)
    // Terminal: out of every selection, with the admission ready and the member's claim and
    // the row's retained claim one authorization.
    expect(second.wallet.pool.capacityCache.has(0)).toBe(false)
    expect(second.wallet.pool.selectForStamp()).toBeUndefined()
    expect(() => second.wallet.leaseManager.acquireLease()).toThrow(
      NoAvailableSubAccountError,
    )
    const obligations = await second.obligations()
    expect(obligations.map(claim => claim.provenance.kind).sort()).toEqual([
      'native',
      'native',
      'pool-retained',
    ])
    expect(
      obligations.find(claim => claim.provenance.kind === 'pool-retained')!
        .transaction!.transactionHash,
    ).toBe(operation.members[0]!.signed!.transactionHash)

    // A second reopen: the pass runs, finds the row applied, and writes nothing.
    await second.wallet.close()
    writes.clear()
    const third = await f.open()
    expect(network.counts()).toEqual(network.untouched)
    expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
    expect(third.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    expect(third.wallet.getNativeOperations!()).toEqual(operations)
    expect(await third.obligations()).toEqual(obligations)
    // The counters above would have seen a request: prove it on this open's own provider.
    await network.control(third.wallet)
  })

  // Pins: each passes on main c32dd683 up to its `pass` count (no pass exists there). What they
  // pin is that open applies only `included-success`, and never looks.
  test.each(['pending', 'included-revert', 'missing'] as const)(
    'pin: a member recorded %s is not applied at open, no lookup is made for it, and its row stays available and reserved',
    async state => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { operations } = await poolSendThenObserved(f, state)
      await f.wallet.close()
      const network = watchOpen()
      const writes = watchWrites()
      const second = await f.open()
      expect(network.counts()).toEqual(network.untouched)
      expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
      expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
      expect(second.wallet.pool.isSpendReserved(0)).toBe(true)
      expect(second.wallet.pool.selectForStamp()).toBeUndefined()
      expect(second.wallet.getNativeOperations!()).toEqual(operations)
      expect(await second.admission()).toMatchObject({ status: 'ready' })
      await network.control(second.wallet)
      jest.mocked(FetchRequest.prototype.send).mockRestore()
      // The node of this session answers with the receipt at once. Only a native send looks:
      // a member that was pending is applied by that send's pass, the others never are.
      second.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
      await second.sendFromMain()
      const [first] = second.wallet.getNativeOperations!()
      if (state === 'pending') {
        expect(first!.members[0]!.observation.state).toBe('included-success')
        expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(first!))
      } else {
        expect(first!.members[0]!.observation.state).toBe(state)
        expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
        expect(second.wallet.pool.isSpendReserved(0)).toBe(true)
      }
      expect(await second.admission()).toMatchObject({ status: 'ready' })
    },
  )

  // Ordering. On main c32dd683 the plan is cancelled at open and nothing follows it: the row
  // stays `available`.
  test('open cancels a never-signed plan first, then applies: an included member held behind that plan is recorded in the same open, before the wallet is published', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { operation } = await poolSendThenObserved(f, 'included-success')
    // A crash between the journal write and the first signature, on the same account at the
    // next nonce: while it stands it holds the address against the included member.
    const plan = await f.bundle.runLifetime(async lifetime => {
      const current = f.bundle.inputAdmission.inspect(lifetime)
      if (current.status !== 'ready') throw new Error(current.reason)
      return f.bundle.inputAdmission.prepareNative(lifetime, current.epoch, {
        kind: 'native',
        recipient: recipient.toLowerCase(),
        intendedValueWei: '1000',
        members: [
          {
            source: { kind: 'spend', address: f.poolAddress, index: 0 },
            dependencies: [],
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: 10143n,
              nonce: 1,
              to: recipient,
              value: 1000n,
              gasLimit: 21000n,
              maxFeePerGas: 1n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
          },
        ],
      })
    })
    await f.wallet.close()
    const network = watchOpen()
    const writes = watchWrites()
    const steps: string[] = []
    writes.cancel.mockImplementation(async function (
      this: EvmLegacyConsolidator,
      lifetime,
    ) {
      steps.push('cancel started')
      await writes.real.cancel.call(this, lifetime)
      steps.push('cancel finished')
    })
    writes.pass.mockImplementation(async function (
      this: EvmLegacyConsolidator,
      lifetime,
    ) {
      steps.push('apply started')
      await writes.real.pass.call(this, lifetime)
      steps.push('apply finished')
    })
    const second = await f.open().then(session => {
      steps.push('wallet published')
      return session
    })
    expect(steps).toEqual([
      'cancel started',
      'cancel finished',
      'apply started',
      'apply finished',
      'wallet published',
    ])
    expect(network.counts()).toEqual(network.untouched)
    expect(second.wallet.getNativeOperations!()).toEqual([
      operation,
      { ...plan, cancelled: true },
    ])
    expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })
    expect(await second.admission()).toMatchObject({ status: 'ready' })
  })

  // Contract case 5. On main c32dd683 there is no pass to skip.
  test('hand-built: while a retained canonical pre-sign intent holds an available row the pass is skipped entirely at open, nothing is written, and the member is applied once the intent is gone', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { operation } = await poolSendThenObserved(f, 'included-success')
    await f.wallet.close()
    const writes = watchWrites()
    // Hand-built: the intent appears once the open-time cancel has run, which is exactly when
    // the block that follows it asks. Everything before that in the open reads the real journal.
    let retained = false
    writes.cancel.mockImplementation(async function (
      this: EvmLegacyConsolidator,
      lifetime,
    ) {
      await writes.real.cancel.call(this, lifetime)
      retained = true
    })
    const realIntents = LevelCanonicalStampAttemptJournal.prototype.getIntents
    const intents = jest
      .spyOn(LevelCanonicalStampAttemptJournal.prototype, 'getIntents')
      .mockImplementation(function (this: LevelCanonicalStampAttemptJournal) {
        return retained
          ? [{ members: [{ reservation: { id: 'r', index: 0 } }] } as never]
          : realIntents.call(this)
      })
    const second = await f.open()
    expect(writes.cancel).toHaveBeenCalledTimes(1)
    expect(intents).toHaveBeenCalled()
    expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })
    expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
    // The same guard still refuses ordinary operations in the session.
    await expect(second.sendFromMain()).rejects.toThrow(
      'Canonical pre-sign intent requires explicit correlation',
    )
    retained = false
    second.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    await second.sendFromMain()
    expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
  })

  // Pin of the failure behaviour for a refusal. Without the pass (main c32dd683) the open is the
  // same; what is pinned is that a refused apply at open is not an open failure and not a write.
  test('a member the admission refuses at open (a later pending member holds its address) does not fail the open and writes nothing; it is applied once that member resolves', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { wallet } = f
    // Both from pool account 0. The first is mined at its broadcast. The node keeps the second
    // without mining it; its planning saw the first included, and its pass was refused.
    await wallet.sendNative({ recipient: { raw: recipient }, value: 50000n })
    f.rpc.broadcast.mockImplementationOnce(
      async raw => ({ hash: keccak256(raw) } as TransactionResponse),
    )
    await wallet.sendNative({ recipient: { raw: recipient }, value: 25000n })
    const operations = wallet.getNativeOperations!()
    expect(
      operations.map(row => [
        row.members[0]!.source.kind,
        Transaction.from(row.members[0]!.signed!.rawTransaction).nonce,
        row.members[0]!.observation.state,
      ]),
    ).toEqual([
      ['spend', 0, 'included-success'],
      ['spend', 1, 'missing'],
    ])
    expect(wallet.pool.getRecord(0)).toEqual(availableRow)
    await wallet.close()

    const network = watchOpen()
    const writes = watchWrites()
    const warned = jest.spyOn(console, 'warn')
    const errored = jest.spyOn(console, 'error')
    const second = await f.open()
    expect(network.counts()).toEqual(network.untouched)
    // The pass ran and reached the admission, which refused before any write.
    expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
    expect(warned).not.toHaveBeenCalled()
    expect(errored).not.toHaveBeenCalled()
    expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(second.wallet.pool.isSpendReserved(0)).toBe(true)
    expect(second.wallet.getNativeOperations!()).toEqual(operations)
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    jest.mocked(FetchRequest.prototype.send).mockRestore()
    // The second transaction is mined; a send from main observes it, and that send's pass
    // applies the first member. The second is then held for good (one checkpoint per row).
    await second.wallet.provider.broadcastTransaction(
      operations[1]!.members[0]!.signed!.rawTransaction,
    )
    second.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    await second.sendFromMain()
    expect(second.wallet.pool.getRecord(0)).toEqual({
      ...availableRow,
      status: 'spent',
      lifecycle: {
        spend: {
          rawTx: operations[0]!.members[0]!.signed!.rawTransaction,
          txHash: operations[0]!.members[0]!.signed!.transactionHash,
          valueWei: '50000',
        },
      },
    })
    expect(await second.admission()).toMatchObject({ status: 'ready' })
  })

  // Contract case 6. On main c32dd683 there is no pass: `pass` cannot be spied.
  test('an apply that throws at open, and a pass that rejects outright, do not fail the open; the member stays unapplied and the next pass applies it', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { operation } = await poolSendThenObserved(f, 'included-success')
    await f.wallet.close()
    const writes = watchWrites()
    // The whole pass rejects: the open's own wrapper.
    writes.pass.mockRejectedValueOnce(new Error('fixture: pass rejected'))
    const second = await f.open()
    expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
    expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    await second.wallet.close()
    writes.clear()
    // The apply itself throws something untyped, before any write.
    const classified = jest
      .spyOn(MonadSubAccountPool.prototype, 'classifySpendOutcome')
      .mockImplementationOnce(() => {
        throw new Error('fixture: untyped apply failure')
      })
    const third = await f.open()
    expect(classified).toHaveBeenCalledTimes(1)
    expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
    expect(third.wallet.pool.getRecord(0)).toEqual(availableRow)
    expect(third.wallet.pool.isSpendReserved(0)).toBe(true)
    expect(await third.admission()).toMatchObject({ status: 'ready' })
    // Not remembered as a hold: the next pass, a native send's, applies it.
    third.transport.mockResolvedValue({ payloadDigest: 'aa' } as never)
    await third.sendFromMain()
    expect(third.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    // And so would the next open have.
    expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })
  })

  // Contract case 8, the accepted fence. On main c32dd683 nothing is written at open, so the
  // fault cannot occur and the session is ready.
  test('a pool write that fails at open leaves the wallet open for inspection and unable to sign for the session; after a real reopen it is ready with the row recorded', async () => {
    const f = await composedWithProductionFundedPoolRow(dir)
    const { operation } = await poolSendThenObserved(f, 'included-success')
    await f.wallet.close()
    const writes = watchWrites()
    const realFlush = LevelSubAccountPoolStore.prototype.flush
    let faulted = false
    const flush = jest
      .spyOn(LevelSubAccountPoolStore.prototype, 'flush')
      .mockImplementation(async function (this: LevelSubAccountPoolStore) {
        // The flush the apply takes for its own put.
        if (writes.commit.mock.calls.length === 1 && !faulted) {
          faulted = true
          throw new Error('fixture: pool write fault')
        }
        return realFlush.call(this)
      })
    const second = await f.open()
    expect(faulted).toBe(true)
    expect(writes.counts()).toMatchObject({ pass: 1, commit: 1 })
    expect(second.wallet.getNativeOperations!()).toHaveLength(1)
    expect(await second.admission()).toMatchObject({
      status: 'unavailable',
      reason: 'uncertain-owner',
    })
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    second.rpc.broadcast.mockClear()
    await expect(second.sendFromMain()).rejects.toThrow('uncertain-owner')
    expect(sign).not.toHaveBeenCalled()
    expect(second.rpc.broadcast).not.toHaveBeenCalled()
    await second.wallet.close()
    flush.mockRestore()
    const third = await f.open()
    expect(await third.admission()).toMatchObject({ status: 'ready' })
    expect(third.wallet.pool.getRecord(0)).toEqual(spentByMember(operation))
    expectNoSpendRecordWithoutItsTransaction(third.wallet)
  })

  // -----------------------------------------------------------------------------------------
  // Stage 3 of #1235, on the composed wallet: `reobserveNativeOperations`, the one method the
  // hosts' polls call. On main dce4bedf the handle has no such method, so each test fails there
  // at its first tick; what main does with a pending member is the `pin` above (only a native
  // send looks). That open neither calls it nor makes a request is asserted by every open in
  // this block through `watchOpen` (`reobserve: 0`), the pending pin included.
  // -----------------------------------------------------------------------------------------
  describe('bounded re-observation of a broadcast member (#1235 Stage 3)', () => {
    /** The consolidator's clock is `Date.now` in composition: moved here, never slept on. */
    const clock = () => {
      const real = Date.now.bind(Date)
      let ahead = 0
      jest.spyOn(Date, 'now').mockImplementation(() => real() + ahead)
      return { advance: (ms: number) => void (ahead += ms) }
    }
    const pendingMember = (wallet: EvmChainWalletHandle) =>
      wallet.getNativeOperations!().slice(-1)[0]!.members[0]!

    test('nothing pending: any number of ticks makes no request at any JSON-RPC layer and observes nothing; with unconfirmed members a tick makes exactly one request each, the receipt request, and writes nothing when it fails', async () => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      const time = clock()
      // A main-sourced send, recorded included: a terminal member, which is never looked up.
      await f.sendFromMain()
      await wallet.estimateLegacyFee!({ recipient: { raw: recipient }, value: 1n })
      expect(
        wallet.getNativeOperations!().map(row => row.members[0]!.observation.state),
      ).toEqual(['included-success'])
      const network = watchOpen()
      const ticks = async (count: number) => {
        for (let i = 0; i < count; i++) {
          time.advance(15_000)
          await expect(wallet.reobserveNativeOperations!()).resolves.toBeUndefined()
        }
      }
      await ticks(100)
      await Promise.all(
        Array.from({ length: 20 }, () => wallet.reobserveNativeOperations!()),
      )
      await settle()
      expect(network.counts()).toEqual({ ...network.untouched, reobserve: 120 })

      // One pool-sourced send the node keeps without a receipt.
      jest.mocked(FetchRequest.prototype.send).mockRestore()
      f.rpc.balances.set(f.main, 40000n)
      const { operations } = await poolSendThenObserved(f, 'pending')
      // The node of that send returned no receipt at all, so its planning recorded the main
      // member `pending` again (the existing observation records what the node says): two
      // members are now unconfirmed, the main one first.
      expect(operations.map(row => row.members[0]!.observation.state)).toEqual([
        'pending',
        'pending',
      ])
      const probes = operations.map(row => [
        'eth_getTransactionReceipt',
        [row.members[0]!.signed!.transactionHash],
      ])
      // From here the receipt request is the provider's real one: it reaches the JSON-RPC
      // layers, where the transport refuses it. This is the positive control for the zero above.
      jest.mocked(wallet.provider.getTransactionReceipt).mockRestore()
      const layers = {
        send: jest.spyOn(JsonRpcProvider.prototype, 'send'),
        batch: jest.spyOn(JsonRpcProvider.prototype, '_send'),
        transport: jest
          .spyOn(FetchRequest.prototype, 'send')
          .mockRejectedValue(new Error('fixture: network touched')),
        observe: jest.spyOn(EvmLegacyConsolidator.prototype, 'observe'),
        capture: jest.spyOn(EvmNativeOperationJournal.prototype, 'beginCapture'),
      }
      // These are the spies the zero above was read from; the send in between used two of them.
      Object.values(layers).forEach(spy => spy.mockClear())
      const writes = watchWrites()
      await ticks(1)
      expect(layers.send.mock.calls).toEqual(probes)
      expect(layers.batch).toHaveBeenCalledTimes(2)
      expect(layers.transport).toHaveBeenCalledTimes(2)
      expect(layers.observe).not.toHaveBeenCalled()
      expect(layers.capture).not.toHaveBeenCalled()
      expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })
      expect(wallet.getNativeOperations!()).toEqual(operations)
      expect(wallet.pool.getRecord(0)).toEqual(availableRow)
      // Inside the member's 15 s wait and the pass floor: nothing more, however many ticks.
      await Promise.all(
        Array.from({ length: 20 }, () => wallet.reobserveNativeOperations!()),
      )
      time.advance(14_000)
      await wallet.reobserveNativeOperations!()
      expect(layers.send).toHaveBeenCalledTimes(2)
      time.advance(1_000)
      await wallet.reobserveNativeOperations!()
      expect(layers.send.mock.calls).toEqual([...probes, ...probes])
      expect(wallet.getNativeOperations!()).toEqual(operations)
    })

    test('the receipt appears: a tick records the inclusion and marks the pool row spent with the member bytes, in the wallet queue; nothing is signed, broadcast or transported, the row leaves every selection, and the next open has nothing left to write', async () => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      const time = clock()
      const { operations } = await poolSendThenObserved(f, 'pending')
      const writes = watchWrites()
      const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
      const flushSync = jest.spyOn(EvmLegacyConsolidator.prototype, 'flushSync')
      f.rpc.broadcast.mockClear()
      // No receipt yet: one probe, nothing written.
      const receipt = jest.mocked(wallet.provider.getTransactionReceipt)
      receipt.mockClear()
      await wallet.reobserveNativeOperations!()
      expect(receipt).toHaveBeenCalledTimes(1)
      expect(wallet.getNativeOperations!()).toEqual(operations)
      expect(wallet.pool.getRecord(0)).toEqual(availableRow)
      expect(wallet.pool.isSpendReserved(0)).toBe(true)
      expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })

      f.withholdReceipts(false)
      time.advance(15_000)
      await wallet.reobserveNativeOperations!()
      const [operation] = wallet.getNativeOperations!()
      expect(operation!.members[0]!.observation).toMatchObject({
        state: 'included-success',
        transactionHash: operation!.members[0]!.signed!.transactionHash,
      })
      expect(wallet.pool.getRecord(0)).toEqual(spentByMember(operation!))
      expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })
      expect(writes.commit).toHaveBeenCalledWith(
        0,
        operation!.members[0]!.signed!.rawTransaction,
      )
      expectNoSpendRecordWithoutItsTransaction(wallet)
      // The account is no longer an available row held back by a reservation: it is terminal,
      // out of every selection, and its claim and the member's are one authorization.
      expect(wallet.pool.capacityCache.has(0)).toBe(false)
      expect(wallet.pool.selectForStamp()).toBeUndefined()
      expect(() => wallet.leaseManager.acquireLease()).toThrow(
        NoAvailableSubAccountError,
      )
      const obligations = await f.obligations()
      expect(obligations.map(claim => claim.provenance.kind).sort()).toEqual([
        'native',
        'pool-retained',
      ])
      expect(
        obligations.find(claim => claim.provenance.kind === 'pool-retained')!
          .transaction!.transactionHash,
      ).toBe(operation!.members[0]!.signed!.transactionHash)
      // Read-only on chain, and no transport step.
      expect(sign).not.toHaveBeenCalled()
      expect(f.rpc.broadcast).not.toHaveBeenCalled()
      expect(flushSync).not.toHaveBeenCalled()
      expect(f.transport).not.toHaveBeenCalled()
      expect(operation!.members[0]!.syncApplied).toBe(false)
      // Terminal: later ticks ask nothing.
      receipt.mockClear()
      for (let i = 0; i < 20; i++) {
        time.advance(600_000)
        await wallet.reobserveNativeOperations!()
      }
      expect(receipt).not.toHaveBeenCalled()
      expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })

      await wallet.close()
      writes.clear()
      const second = await f.open()
      expect(writes.counts()).toEqual({ pass: 1, commit: 0, putMany: 0 })
      expect(second.wallet.pool.getRecord(0)).toEqual(spentByMember(operation!))
      expect(await second.admission()).toMatchObject({ status: 'ready' })
    })

    test('a node that never answers the probe: a native send completes meanwhile, the wallet queues are free, the wallet closes without waiting for the node, and an answer after close records nothing and rejects nothing', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => void unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const f = await composedWithProductionFundedPoolRow(dir)
        const { wallet } = f
        clock()
        const { operations } = await poolSendThenObserved(f, 'pending')
        const hash = pendingMember(wallet).signed!.transactionHash
        const landed = f.rpc.receipts.get(hash)!
        let answer!: (receipt: typeof landed) => void
        jest.mocked(wallet.provider.getTransactionReceipt).mockImplementationOnce(
          () =>
            new Promise(resolve => {
              answer = resolve
            }),
        )
        let returned = false
        const tick = wallet.reobserveNativeOperations!().then(() => {
          returned = true
        })
        await settle()
        expect(answer).toBeDefined()
        // A second tick while the first is in flight starts nothing and returns at once.
        await wallet.reobserveNativeOperations!()
        // The whole native send path: the wallet queue, the bundle's operation queue, the main
        // account queue and the executor queue. A canonical send waits on the first two.
        const sent = await f.sendFromMain()
        expect(wallet.getNativeOperations!().slice(-1)[0]!.members[0]).toMatchObject({
          source: { kind: 'main' },
          exposed: true,
          signed: { transactionHash: sent.txHash },
        })
        expect(returned).toBe(false)
        await wallet.close()
        await tick
        answer(landed)
        await settle()
        await settle()
        const second = await f.open()
        expect(second.wallet.getNativeOperations!()[0]).toEqual(operations[0])
        expect(second.wallet.pool.getRecord(0)).toEqual(availableRow)
        expect(second.wallet.pool.isSpendReserved(0)).toBe(true)
        expect(await second.admission()).toMatchObject({ status: 'ready' })
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    test('hand-built: while a retained canonical pre-sign intent holds an available row the wallet queue refuses the local pass; the tick does not throw, the observation stays recorded, and a later tick applies it without a request once the intent is gone', async () => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      const time = clock()
      await poolSendThenObserved(f, 'pending')
      f.withholdReceipts(false)
      const writes = watchWrites()
      const intents = jest
        .spyOn(LevelCanonicalStampAttemptJournal.prototype, 'getIntents')
        .mockReturnValue([
          { members: [{ reservation: { id: 'r', index: 0 } }] } as never,
        ])
      await expect(wallet.reobserveNativeOperations!()).resolves.toBeUndefined()
      const [operation] = wallet.getNativeOperations!()
      expect(operation!.members[0]!.observation.state).toBe('included-success')
      expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })
      expect(wallet.pool.getRecord(0)).toEqual(availableRow)
      // Still refused 15 s later; the guard is the wallet queue's own.
      time.advance(15_000)
      await expect(wallet.reobserveNativeOperations!()).resolves.toBeUndefined()
      expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })
      await expect(f.sendFromMain()).rejects.toThrow(
        'Canonical pre-sign intent requires explicit correlation',
      )
      intents.mockRestore()
      const receipt = jest.mocked(wallet.provider.getTransactionReceipt)
      receipt.mockClear()
      time.advance(15_000)
      await wallet.reobserveNativeOperations!()
      expect(writes.counts()).toEqual({ pass: 1, commit: 1, putMany: 1 })
      expect(wallet.pool.getRecord(0)).toEqual(spentByMember(operation!))
      expect(receipt).not.toHaveBeenCalled()
      expect(await f.admission()).toMatchObject({ status: 'ready' })
    })

    test('a closed wallet: the method resolves, asks nothing and writes nothing', async () => {
      const f = await composedWithProductionFundedPoolRow(dir)
      const { wallet } = f
      await poolSendThenObserved(f, 'pending')
      f.withholdReceipts(false)
      const receipt = jest.mocked(wallet.provider.getTransactionReceipt)
      await wallet.close()
      receipt.mockClear()
      const writes = watchWrites()
      await expect(wallet.reobserveNativeOperations!()).resolves.toBeUndefined()
      expect(receipt).not.toHaveBeenCalled()
      expect(writes.counts()).toEqual({ pass: 0, commit: 0, putMany: 0 })
    })
  })
})

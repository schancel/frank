import {
  Mnemonic,
  Network,
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
import { EvmNativeOperationPendingError } from './evm-legacy-consolidator'
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
  'actual wallet publication waits for the %s owner; failure cannot publish, and warming stays off',
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
    const warm = jest
      .spyOn(MonadSubAccountPool.prototype, 'triggerProactiveWarming')
      .mockImplementation(() => undefined)
    const configure = jest.spyOn(
      MonadSubAccountPool.prototype,
      'configureProactiveWarming',
    )
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
      expect(warm).not.toHaveBeenCalled()
      expect(configure).not.toHaveBeenCalled()
      release()
      await opening
      expect(configure).not.toHaveBeenCalled()
      expect(warm).not.toHaveBeenCalled()
      await wallet!.close()
      wallet = undefined
      warm.mockClear()
      configure.mockClear()
      open.mockRejectedValueOnce(new Error('required owner failed'))
      await expect(createEvmChain(cfg).createWallet(roots())).rejects.toThrow(
        'required owner failed',
      )
      expect(warm).not.toHaveBeenCalled()
      expect(configure).not.toHaveBeenCalled()
      open.mockRestore()
      wallet = await createEvmChain(cfg).createWallet(roots())
      expect(configure).not.toHaveBeenCalled()
      expect(warm).not.toHaveBeenCalled()
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
  const transactions = new Map<string, TransactionResponse>()
  const receipts = new Map<string, TransactionReceipt>()
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
  return { broadcast, balances }
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
    const wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    const bundle = opened[opened.length - 1]!
    return {
      wallet,
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
  // The composed path really delivered the consolidator's item to the pool: no raw bytes, and the
  // fee folded into the value.
  expect(processed).toHaveBeenCalledTimes(1)
  expect(processed.mock.calls[0]![0]).toMatchObject({
    type: 'wallet-sync',
    direction: 'out',
    txHash: member.signed!.transactionHash,
    spentInputs: [{ address: poolAddress, nonce: 0, valueWei: '121000' }],
  })
  expect(processed.mock.calls[0]![0]).not.toHaveProperty('rawTx')
  return { ...first, rpc, sent, operation, open, item: processed.mock.calls[0]![0] }
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
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    // What this stage produces: the drained row is not yet marked; the next stage marks it from
    // the journal member, which is unchanged on disk.
    expect(wallet.pool.getRecord(0)).toEqual({
      index: 0,
      address: expected[0].pool,
      status: 'available',
    })
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
    expect(wallet.pool.getRecord(0)).toEqual({
      index: 0,
      address: expected[0].pool,
      status: 'available',
    })
    expectNoSpendRecordWithoutItsTransaction(wallet)
    // The drained account is not offered from the stale funded-capacity entry, nor at all: the
    // journal member that spent from it reserves it until the row is recorded spent.
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

// Stage 0b of #1235. Until this stage the test here was "the same item carrying the journal
// member's signed transaction is a spend record admission accepts across reopen": it called the
// dispatcher synchronously, expected `{ affectedIndices: [0] }` and one putMany, and expected the
// row `spent`. Those assertions pinned the defect this stage closes: a signed transaction committed
// through the sync boundary on a composed wallet outside the wallet queue and the admission, with
// no chain check, the write not awaited. No applier is attached yet, so the item is refused; the
// next stage attaches one that runs under the admission and restores the commit. On the base this
// fails: the call returns a result instead of rejecting, and the row is committed.
test('a complete item for a composed wallet is refused at the sync boundary until an applier checks it; the wallet reopens (#1235)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-1235-spend-record-bytes-'))
  let wallet: EvmChainWalletHandle | undefined
  try {
    const first = await sendLegacyFromProductionFundedPoolRow(dir)
    wallet = first.wallet
    const signed = first.operation.members[0]!.signed!
    const untouched = {
      index: 0,
      address: expected[0].pool,
      status: 'available',
    }
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    const complete = { ...first.item, rawTx: signed.rawTransaction }
    const refused = await Promise.resolve()
      .then(() => applyWalletSyncItem(wallet, complete as never))
      .then(
        value => ({ value }),
        (error: unknown) => ({ error }),
      )
    expect(refused).toEqual({ error: expect.any(SubAccountSpendRefusedError) })
    expect(refused).toMatchObject({ error: { code: 'no-applier', index: 0 } })
    // Another chain's item does not reach the pool at all.
    await expect(
      applyWalletSyncItem(wallet, {
        ...complete,
        chainIdentifier: 'ethereum-sepolia',
      } as never),
    ).rejects.toMatchObject({ code: 'chain-mismatch' })
    await wallet.pool.flush()
    expect(putMany).not.toHaveBeenCalled()
    expect(wallet.pool.getRecord(0)).toEqual(untouched)
    const retained = (snapshot: Awaited<ReturnType<typeof first.admission>>) =>
      snapshot.status === 'ready'
        ? snapshot.obligations
            .filter(claim => claim.provenance.kind === 'pool-retained')
            .map(claim => [claim.provenance, claim.transaction?.transactionHash])
        : snapshot
    expect(retained(await first.admission())).toEqual([])
    await wallet.close()
    wallet = undefined
    const second = await first.open()
    wallet = second.wallet
    expect(retained(await second.admission())).toEqual([])
    expect(wallet.pool.getRecord(0)).toEqual(untouched)
    expectNoSpendRecordWithoutItsTransaction(wallet)
  } finally {
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// Stage 0b of #1235: the native callback now awaits the dispatch, and its own item (still without
// the signed transaction) is refused by the pool. The send ends in the same error class as before,
// `EvmNativeOperationPendingError`; only its reason changes, from the transport's refusal to the
// pool's. On the base this fails at the reason: the dispatch result is dropped and the callback
// goes on to the transport step, whose refusal is what the pending error carries.
test('a pool-sourced legacy send still ends in the pending error, now from the refused sync item, with admission ready and the wallet reopenable (#1235)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-1235-spend-record-pending-'))
  let wallet: EvmChainWalletHandle | undefined
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const first = await sendLegacyFromProductionFundedPoolRow(dir)
    wallet = first.wallet
    expect(first.sent.value).toBeUndefined()
    expect(first.sent.error).toBeInstanceOf(EvmNativeOperationPendingError)
    const pending = first.sent.error as EvmNativeOperationPendingError
    expect(pending.name).toBe('EvmNativeOperationPendingError')
    expect(pending.transaction.txHash).toBe(
      first.operation.members[0]!.signed!.transactionHash,
    )
    expect(pending.reason).toBeInstanceOf(SubAccountSpendRefusedError)
    expect(pending.reason).toMatchObject({
      code: 'missing-transaction',
      index: 0,
    })
    expect(first.operation.members[0]!.syncApplied).toBe(false)
    expect(await first.admission()).toMatchObject({ status: 'ready' })
    expect(wallet.pool.getRecord(0)).toEqual({
      index: 0,
      address: expected[0].pool,
      status: 'available',
    })
    await wallet.close()
    wallet = undefined
    const second = await first.open()
    wallet = second.wallet
    expect(await second.admission()).toMatchObject({ status: 'ready' })
    expect(wallet.getNativeOperations!()).toEqual([first.operation])
    await new Promise(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
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
      expect(wallet.pool.getRecord(0)).toEqual({
        index: 0,
        address: expected[0].pool,
        status: 'available',
      })
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

test('retiring a pool account on a normally opened wallet builds and submits no warming transfer (#1235)', async () => {
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
  const dir = await mkdtemp(join(tmpdir(), 'frank-warming-off-'))
  const wallet = (await createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    jest.spyOn(wallet.provider, 'getBalance').mockResolvedValue(0n)
    wallet.pool.setStatus(0, 'in-use')
    wallet.pool.setStatus(0, 'retired')
    wallet.pool.triggerProactiveWarming()
    await wallet.pool.ensureMinimumAvailableCapacity()
    expect(built).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
    expect(wallet.pool.getProactiveWarmingConfig()).toBeUndefined()
    expect(
      wallet.pool.records().filter(row => row.status === 'funding'),
    ).toEqual([])
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
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

test('conflicting recovered owners remain read-only without configuring or starting warming', async () => {
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
  const warm = jest
    .spyOn(MonadSubAccountPool.prototype, 'triggerProactiveWarming')
    .mockImplementation(() => undefined)
  const dir = await mkdtemp(join(tmpdir(), 'frank-stage-a-conflict-warm-'))
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
    const sign = jest
      .spyOn(Wallet.prototype, 'signTransaction')
      .mockRejectedValueOnce(new Error('fixture unsigned native'))
    await expect(
      wallet.sendNative({ recipient: { raw: expected[1].main }, value: 1n }),
    ).rejects.toThrow('fixture unsigned native')
    sign.mockRestore()
    const nativeBefore = wallet.getNativeOperations!()
    expect(nativeBefore).toHaveLength(1)
    expect(nativeBefore[0].cancelled).toBe(false)
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
    warm.mockRestore()
    const built = jest.fn(async () => ({
      rawTx: '0x1234',
      txHash: '0x' + 'ab'.repeat(32),
    }))
    const submitted = jest.fn(async () => '0x' + 'ab'.repeat(32))
    const configured = jest.spyOn(
      MonadSubAccountPool.prototype,
      'configureProactiveWarming',
    )
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
    expect(configured).not.toHaveBeenCalled()
  } finally {
    await wallet?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

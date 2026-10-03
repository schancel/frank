import { Mnemonic } from 'ethers'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import { createChain } from './chain-factory'
import {
  createMonadChain,
  MonadChainConfig,
  MonadChainWalletHandle,
} from './monad-chain'
import type { MonadRootBundle } from './active-chain'
import {
  InMemoryNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
} from './chain-wallet'
import * as materialModule from '../monad-wallet-material'
import * as providerModule from '../monad-provider'
import { MonadAccountTxSigner } from '../monad-account-tx'
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
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

const config: MonadChainConfig = {
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

test('rejects a second factory owner of the same EVM inventory until close', async () => {
  const firstChain = createMonadChain(config)
  const first = await firstChain.createWallet(roots())
  const otherChain = createMonadChain(config)
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
    createMonadChain(config).createWallet({
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
    const chain = await createChain({ kind: 'monad', config })
    const wallet = (await chain.createWallet(
      roots(index),
    )) as MonadChainWalletHandle
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
    const wallet = (await createMonadChain(config).createWallet(
      bundle,
    )) as MonadChainWalletHandle
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
    const chain = createMonadChain({
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
  const chain = createMonadChain(config)
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

test('typed DM entrypoints fail closed before plaintext, payment, or network access', async () => {
  const chain = createMonadChain(config)
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
  ).rejects.toThrow('#696')
  await expect(
    chain.directMessages.fetchSince({ wallet, sinceMs: 0 }),
  ).rejects.toThrow('#696')
  await expect(
    chain.directMessages.reconcileAttempts({ wallet, payloadDigests: [] }),
  ).rejects.toThrow('#696')
  await expect(
    chain.directMessages.unattributedAttempts({ wallet, knownDigests: [] }),
  ).rejects.toThrow('#696')
  await expect(
    chain.directMessages.listRecoveredStampPayments({ wallet }),
  ).rejects.toThrow('#696')
  await expect(
    chain.directMessages.sweepRecoveredStampPayment({
      wallet,
      payloadDigest: '00',
      childIndex: 0,
      destination: { raw: expected[0].main },
    }),
  ).rejects.toThrow('#696')
  expect(plaintextRead).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
  expect(signer).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  await wallet.close()
})

test('native signing and recovered pending attempts belong to EVM main across auth changes', async () => {
  const store = new InMemoryNativeTransactionAttemptStore()
  const chain = createMonadChain({ ...config, nativeAttemptStore: store })
  const wallet = await chain.createWallet(roots())
  const signed = { txHash: `0x${'44'.repeat(32)}` }
  const submit = jest.fn().mockRejectedValue(new Error('reply lost'))
  const build = jest.fn().mockResolvedValue(signed)
  const signer = MonadAccountTxSigner as jest.MockedClass<
    typeof MonadAccountTxSigner
  >
  signer.mockImplementation(
    () =>
      ({
        buildAndSignTransfer: build,
        submit,
      } as unknown as MonadAccountTxSigner),
  )
  await expect(
    wallet.sendNative({ recipient: { raw: expected[1].main }, value: 1n }),
  ).rejects.toThrow('unknown')
  expect(signer).toHaveBeenLastCalledWith(
    expect.objectContaining({ privateKey: expected[0].mainSecret }),
  )
  expect(
    store.get(
      nativeTransactionAttemptKey({
        chainKind: 'monad',
        networkId: '10143',
        address: expected[0].main.toLowerCase(),
      }),
    ),
  ).toEqual(signed)
  await wallet.close()
  const restored = (await createMonadChain({
    ...config,
    nativeAttemptStore: store,
  }).createWallet({
    ...roots(),
    authentication: roots(1).authentication,
  })) as MonadChainWalletHandle
  expect(restored.getUnresolvedNativeTransaction!()).toEqual(signed)
  jest.spyOn(restored.provider, 'getTransactionReceipt').mockResolvedValue(null)
  await expect(
    restored.sendNative({ recipient: { raw: expected[1].main }, value: 2n }),
  ).rejects.toThrow('unknown')
  expect(build).toHaveBeenCalledTimes(1)
  await restored.close()
})

test.each([false, true])(
  'authentication signs relay challenges while topic funding uses EVM main (another facade: %s)',
  async anotherFacade => {
    const provider = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
    const chain = createMonadChain(config)
    const wallet = (await chain.createWallet(roots())) as MonadChainWalletHandle
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
        (anotherFacade ? createMonadChain(config) : chain).topics.post({
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

test('close drains an in-flight native operation and rejects further work', async () => {
  const chain = createMonadChain({
    ...config,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const wallet = await chain.createWallet(roots())
  const destroyHttp = jest.spyOn(MonadHttpClient.prototype, 'destroy')
  const signed = { txHash: `0x${'55'.repeat(32)}` }
  let release!: () => void
  let started!: () => void
  const signing = new Promise<void>(resolve => (started = resolve))
  const wait = new Promise<void>(resolve => (release = resolve))
  const signer = MonadAccountTxSigner as jest.MockedClass<
    typeof MonadAccountTxSigner
  >
  const submit = jest.fn().mockResolvedValue(signed.txHash)
  signer.mockImplementation(
    () =>
      ({
        buildAndSignTransfer: jest.fn().mockResolvedValue(signed),
        submit,
      } as unknown as MonadAccountTxSigner),
  )
  const send = wallet.sendNative({
    recipient: { raw: expected[1].main },
    value: 1n,
    onSigned: async () => {
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
  expect(submit).not.toHaveBeenCalled()
  expect(destroyHttp).not.toHaveBeenCalled()
  release()
  await expect(send).resolves.toEqual(signed)
  await close
  expect(submit).toHaveBeenCalledTimes(1)
  expect(destroyHttp).toHaveBeenCalledTimes(1)
})

test('cached callers serialize native sends through the same economic owner', async () => {
  const chain = createMonadChain({
    ...config,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const [first, second] = await Promise.all([
    chain.createWallet(roots()),
    chain.createWallet(roots()),
  ])
  expect(second).toBe(first)
  let release!: () => void
  let started!: () => void
  const signing = new Promise<void>(resolve => (started = resolve))
  const wait = new Promise<void>(resolve => (release = resolve))
  const signer = MonadAccountTxSigner as jest.MockedClass<
    typeof MonadAccountTxSigner
  >
  const build = jest
    .fn()
    .mockResolvedValueOnce({ txHash: `0x${'66'.repeat(32)}` })
    .mockResolvedValueOnce({ txHash: `0x${'77'.repeat(32)}` })
  signer.mockImplementation(
    () =>
      ({
        buildAndSignTransfer: build,
        submit: jest.fn(async signed => signed.txHash),
      } as unknown as MonadAccountTxSigner),
  )
  const a = first.sendNative({
    recipient: { raw: expected[1].main },
    value: 1n,
    onSigned: async () => {
      started()
      await wait
    },
  })
  await signing
  const b = second.sendNative({
    recipient: { raw: expected[1].main },
    value: 2n,
  })
  await Promise.resolve()
  expect(build).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([a, b])
  expect(build).toHaveBeenCalledTimes(2)
  await first.close()
})

test('reopens existing EVM inventory after close even when authentication changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-716-'))
  await mkdir(join(dir, `wallet-evm-${expected[0].main.toLowerCase()}`))
  try {
    const cfg = { ...config, walletStorageLocation: join(dir, 'wallet') }
    const first = (await createMonadChain(cfg).createWallet(
      roots(),
    )) as MonadChainWalletHandle
    first.pool.setStatus(0, 'retired')
    await first.close()
    const second = (await createMonadChain(cfg).createWallet({
      ...roots(),
      authentication: roots(1).authentication,
    })) as MonadChainWalletHandle
    expect(second.pool.getRecord(0)!.status).toBe('retired')
    expect(second.pool.getRecord(0)!.address).toBe(expected[0].pool)
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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
    const chain = createMonadChain(cfg)
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
  const chain = createMonadChain({
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
  const wallet = (await chain.createWallet(roots())) as MonadChainWalletHandle
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
    createMonadChain(config).createWallet({
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    }),
  ).rejects.toThrow('fixture resume failure')
  expect(providers.mock.results).toHaveLength(2)
  expect(providers.mock.results.every(result => result.value.destroyed)).toBe(
    true,
  )
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
    const wallet = await createMonadChain({
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

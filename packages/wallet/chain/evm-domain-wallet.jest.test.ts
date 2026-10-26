import { evmWalletInternals } from '../evm-wallet'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import {
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
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
} from '@frank/codec'
import { freezeCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import dmCorpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import {
  LevelCanonicalStampAttemptJournal,
  type CanonicalPreparedAttempt,
} from '../storage/stamp-attempt-journal'
import { CanonicalWalletBindingMismatchError } from '../storage/evm-wallet-bundle'
import { tmpdir } from 'os'
import { join } from 'path'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import { createChain } from './chain-factory'
import { getChainRegistryEntry } from './chains-registry'
import {
  canonicalMonadStampClient,
  createEvmChain,
  prepareMonadRevisionZeroExport,
} from "./evm-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import type { MonadRootBundle } from './active-chain'
import {
  InMemoryNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
} from './chain-wallet'
import * as materialModule from '../evm-wallet-material'
import * as providerModule from '../evm-provider'
import { MonadAccountTxSigner } from '../evm-account-tx'
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
import { LevelChangePoolStore } from '../storage/level-change-pool-store'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { MonadSubAccountPool } from '../evm-account-pool'
import { applyWalletSyncItem } from '../sync-dispatcher'
import type { WalletSyncItem } from '@frank/cashweb/types/messages'
import { EvmLegacyConsolidator } from './evm-legacy-consolidator'
import { LegacyTransactionSetPendingError } from './evm-legacy-transaction-set'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type EvmTransactionSetPolicy,
} from '../evm-transaction-set-types'
import { LevelStampPaymentJournal } from '../storage/stamp-payment-journal'
import * as topicModule from '../topic-post-client'
import { MonadHttpClient } from '../evm-http'
import * as coinStoreModule from '../storage/evm-coin-store'
import { createServer } from 'http'
import type { AddressInfo } from 'net'

jest.mock('../evm-account-tx', () => ({
  ...jest.requireActual('../evm-account-tx'),
  MonadAccountTxSigner: jest.fn(),
}))

const config: EvmChainConfig = {
  networkId: 'monad-testnet',
  chainId: 10143,
  rpcChain: 'monad-testnet',
  relayBaseUrl: 'http://127.0.0.1:1',
  networkTag: 'MONT',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  resolveDefaultStamp: fixedStampDefault(1n),
  defaultTopicVoteValueWei: 1n,
  subAccountPoolSize: 2,
  walletStorageLocation: false,
  // These tests count the balance reads of a stub node; the seed walk has its own suites
  // (evm-seed-discovery, chain/evm-seed-restore.anvil).
  seedDiscovery: false,
  // The stub node quotes gas at 1 wei and mines nothing on its own: a fixed policy with no
  // Monad spend-rule wait, so a Send of the coin list builds from what the stub reports. Dust
  // above every balance here keeps each residual on its account's next nonce, so a Send is the
  // one payment these tests count (the change split has its own suites).
  transactionSetPolicy: (): EvmTransactionSetPolicy => ({
    sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
    gasPriceWei: 1n,
    paymentGasLimit: () => 21_000n,
    changeGasLimit: 21_000n,
    paymentFeeIsExact: true,
    dustWei: 10n ** 15n,
    radix: 2,
    jitterBps: 1_500,
    maxChangeOutputs: 20,
    head: 1,
  }),
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

/** After a native send the wallet tells the account's other devices with a free note to itself.
 * The note is started, not waited for: call this at wallet open, and its result when a test needs
 * the notes started so far to have settled. */
function watchNotes() {
  // Every flush goes through `startSync`.
  const started = jest.spyOn(EvmLegacyConsolidator.prototype, 'startSync')
  return async () => {
    for (const result of started.mock.results)
      await Promise.resolve(result.value as unknown).catch(() => undefined)
    for (const owner of new Set(started.mock.contexts)) await owner.drain()
  }
}
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
    const prepare = jest.spyOn(
      MonadSubAccountPool.prototype,
      'prepareStampInventory',
    )
    jest.mocked(MonadAccountTxSigner).mockClear()
    const nothingFunded = () => {
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
      // The balance is the main account's and the identity account's: both are spendable.
      expect(await chain.nativeTransfers.getBalance({ wallet })).toBe(246n)
      expect(balance).toHaveBeenCalledWith(expected[index].main)
      expect(balance).toHaveBeenCalledWith(expected[index].auth)
    } finally {
      await wallet.close()
    }
  },
)

test.each([
  { networkId: "monad-testnet", chainId: 10143 },
  { networkId: "ethereum-sepolia", chainId: 11155111 },
  { networkId: "hyperliquid-testnet", chainId: 998 },
])(
  "coalesces balance refreshes and starts primary address reads together on $networkId",
  async (network) => {
    const entry = getChainRegistryEntry(network.networkId)!;
    const wallet = (await createEvmChain({
      ...config,
      ...network,
      networkTag: entry.networkTag,
      rpcChain: entry.id,
    }).createWallet(roots())) as EvmChainWalletHandle;
    const releases: Array<(value: bigint) => void> = [];
    const read = jest.spyOn(wallet.provider, "getBalance").mockImplementation(
      () =>
        new Promise<bigint>((resolve) => {
          releases.push(resolve);
        })
    );
    try {
      const first = wallet.getBalance();
      const second = wallet.getBalance();
      // Both independent primary addresses begin before either response arrives.
      expect(read).toHaveBeenCalledTimes(2);
      releases.splice(0).forEach((resolve) => resolve(123n));
      expect(await first).toBe(246n);
      expect(await second).toBe(246n);
      // Previously concurrent complete reads each requested both addresses (four requests).
      expect(read).toHaveBeenCalledTimes(2);
      wallet.invalidateBalanceCache();
      read
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(0n);
      await expect(wallet.getBalance()).rejects.toThrow("offline");
      read.mockResolvedValue(234n);
      expect(await wallet.getBalance()).toBe(468n);
    } finally {
      releases.forEach((resolve) => resolve(0n));
      await wallet.close();
    }
  }
);

test("authority invalidation starts a fresh balance read while the previous one is pending", async () => {
  const wallet = (await createEvmChain(config).createWallet(
    roots()
  )) as EvmChainWalletHandle;
  const releases: Array<(value: bigint) => void> = [];
  const read = jest.spyOn(wallet.provider, "getBalance").mockImplementation(
    () =>
      new Promise<bigint>((resolve) => {
        releases.push(resolve);
      })
  );
  try {
    const previous = wallet.getBalance();
    wallet.invalidateBalanceCache();
    const current = wallet.getBalance();
    expect(read).toHaveBeenCalledTimes(4);
    const joining = wallet.getBalance();
    expect(read).toHaveBeenCalledTimes(4);
    releases.splice(2).forEach((resolve) => resolve(234n));
    expect(await current).toBe(468n);
    expect(await joining).toBe(468n);
    releases.splice(0).forEach((resolve) => resolve(123n));
    expect(await previous).toBe(246n);
    // An older read completing last must not replace the current cached observation.
    expect(await wallet.getBalance()).toBe(468n);
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    releases.forEach((resolve) => resolve(0n));
    await wallet.close();
  }
});

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
    wallet.sendLegacy!({ recipient: { raw: expected[0].main }, value: 1n }),
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
  jest.spyOn(wallet.provider, 'getBlockNumber').mockResolvedValue(1)
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
      const to = tx.to!.toLowerCase()
      balances.set(to, (balances.get(to) ?? 0n) + tx.value)
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

test.each(["included", "pending", "uncertain"] as const)(
  "native resume refreshes the balance after an %s outcome without replacing the payment",
  async (outcome) => {
    const chain = createEvmChain(config);
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle;
    const rpc = mockNativeRpc(wallet, { [expected[0].main]: 100000n });
    jest
      .spyOn(chain.directMessages, "send")
      .mockResolvedValue({ payloadDigest: "aa" } as never);
    const broadcast = rpc.broadcast.getMockImplementation()!;
    try {
      rpc.broadcast.mockRejectedValueOnce(new Error("node unavailable"));
      await expect(
        wallet.sendLegacy!({
          recipient: { raw: expected[1].main },
          value: 1000n,
        })
      ).rejects.toThrow();
      const operation = wallet.getNativeOperations!()[0]!;
      const original = operation.members[0].signed!.rawTransaction;
      expect(operation.kind).toBe("transaction-set");
      // Not on chain yet: the balance is what the chain holds.
      expect(await wallet.getBalance()).toBe(100000n);

      if (outcome === "pending") {
        rpc.broadcast.mockImplementation(
          async () => ({ hash: keccak256(original) } as TransactionResponse)
        );
      } else if (outcome === "uncertain") {
        rpc.broadcast.mockImplementation(async (raw) => {
          await broadcast(raw);
          // The original landed, but submission and receipt observations fail for this call.
          jest
            .mocked(wallet.provider.getTransaction)
            .mockRejectedValue(new Error("offline"));
          jest
            .mocked(wallet.provider.getTransactionReceipt)
            .mockRejectedValue(new Error("offline"));
          throw new Error("connection reset after broadcast");
        });
      }

      // An uncertain answer may be reported or kept as pending: either way the original
      // operation stays the only one, with its original bytes.
      const resumed = await wallet
        .resumeNativeOperation!(operation.operationId)
        .then(() => undefined, (error: unknown) => error);
      if (outcome !== "uncertain") expect(resumed).toBeUndefined();

      const balanceReads = jest.mocked(wallet.provider.getBalance).mock.calls
        .length;
      expect(await wallet.getBalance()).toBe(
        outcome === "pending" ? 100000n : 78000n
      );
      expect(
        jest.mocked(wallet.provider.getBalance).mock.calls.length
      ).toBeGreaterThan(balanceReads);
      expect(rpc.broadcast.mock.calls.every(([raw]) => raw === original)).toBe(
        true
      );
      if (outcome === "included") {
        // Complete: the journal archives it, and nothing is left to resume.
        expect(wallet.getNativeOperations!()).toEqual([]);
        expect(rpc.transactions.size).toBe(1);
        return;
      }
      expect(wallet.getNativeOperations!()).toHaveLength(1);
      expect(
        wallet.getNativeOperations!()[0].members[0].signed!.rawTransaction
      ).toBe(original);
      expect(wallet.getNativeOperations!()[0].cancelled).toBeFalsy();
      // A later retry finishes this same operation, including when the earlier answer was lost.
      rpc.broadcast.mockImplementation(broadcast);
      jest
        .mocked(wallet.provider.getTransaction)
        .mockImplementation(async (hash) => rpc.transactions.get(hash) ?? null);
      jest
        .mocked(wallet.provider.getTransactionReceipt)
        .mockImplementation(async (hash) => rpc.receipts.get(hash) ?? null);
      await wallet.resumeNativeOperation!(operation.operationId);
      expect(await wallet.getBalance()).toBe(78000n);
      expect(rpc.transactions.size).toBe(1);
      expect(rpc.broadcast.mock.calls.every(([raw]) => raw === original)).toBe(
        true
      );
    } finally {
      await wallet.close();
    }
  }
);

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
      first.sendLegacy!({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('retained pending')
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
    // The restored wallet finds the same Send unresolved and finishes it with its own bytes.
    const unresolved = restored.getUnresolvedLegacySend!()
    expect(unresolved.map(operation => operation.operationId)).toEqual([
      row.operationId,
    ])
    const tx = await restored.resumeLegacySend!(row.operationId)
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

test('a real Sepolia owner retries the original sync event without signing or broadcasting twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-sepolia-sync-restart-'))
  // The mailbox is down for the whole first session, however often the wallet retries.
  let mailboxUp = false
  const emitWalletSync = jest.fn(async () => {
    if (!mailboxUp) throw new Error('primary mailbox unavailable')
  })
  const cfg: EvmChainConfig = {
    ...config,
    networkId: 'ethereum-sepolia',
    rpcChain: 'ethereum-sepolia',
    chainIdentifier: 'ethereum-sepolia',
    chainId: 11155111,
    networkTag: 'SEPO',
    walletStorageLocation: join(dir, 'wallet'),
    emitWalletSync,
  }
  const chain = createEvmChain(cfg)
  let wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  try {
    const rpc = mockNativeRpc(wallet, { [expected[0].main]: 100000n })
    jest.spyOn(wallet.provider, 'getNetwork')
      .mockResolvedValue(Network.from(11155111))
    const notesSettled = watchNotes()
    const sent = await wallet.sendLegacy!({
      recipient: { raw: expected[1].main },
      value: 1000n,
    })
    await wallet.reobserveNativeOperations!()
    const operationId = wallet.getNativeOperations!()[0]!.operationId
    await wallet.resumeNativeOperation!(operationId)
    await notesSettled()
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    expect(wallet.getNativeOperations!()[0]!.members[0]!.observation.state)
      .toBe('included-success')
    const failedNotes = emitWalletSync.mock.calls.length
    expect(failedNotes).toBeGreaterThanOrEqual(1)
    expect(wallet.getNativeOperations!()[0]!.members[0]!.syncApplied).toBe(false)
    await wallet.close()
    mailboxUp = true
    wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    const restartedBroadcast = jest.spyOn(wallet.provider, 'broadcastTransaction')
    const remaining = await wallet.flushNativeSync!()
    await notesSettled()
    expect(remaining).toEqual([])
    expect(restartedBroadcast).not.toHaveBeenCalled()
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    // Delivered once after the restart, as the same note: same item, same message identity.
    expect(emitWalletSync).toHaveBeenCalledTimes(failedNotes + 1)
    const [item, swapRecord, messageId] = emitWalletSync.mock.calls[0]! as unknown as [
      WalletSyncItem,
      unknown,
      Uint8Array,
    ]
    expect(item).toMatchObject({
      type: 'wallet-sync',
      chainIdentifier: 'ethereum-sepolia',
      txHash: sent.txHash,
    })
    expect(swapRecord).toBeUndefined()
    expect(messageId).toEqual(getBytes(keccak256(Buffer.from(
      `frank-wallet-sync:ethereum-sepolia:${sent.txHash}`,
    ))).slice(0, 16))
    const delivered = emitWalletSync.mock.calls[failedNotes]! as unknown as [
      WalletSyncItem,
      unknown,
      Uint8Array,
    ]
    expect(delivered[0]).toMatchObject({
      chainIdentifier: item.chainIdentifier,
      txHash: item.txHash,
      rawTx: item.rawTx,
    })
    expect(delivered[2]).toEqual(messageId)
    // Delivered and complete: the journal archives the finished Send.
    expect(
      wallet.getNativeOperations!().every(row =>
        row.members.every(member => member.syncApplied),
      ),
    ).toBe(true)
  } finally {
    await wallet.close()
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
        .spyOn(topicModule.TopicPostClient.prototype, 'submitTopicPost')
        .mockResolvedValue({ payloadHashHex: 'aa' } as Awaited<
          ReturnType<topicModule.TopicPostClient['submitTopicPost']>
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
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      await wallet.close()
    }
  },
)

test('secondary EVM RPC auth uses the captured home directory tag while retaining the target chain', async () => {
  const provider = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
  const wallet = (await createEvmChain({
    ...config,
    networkId: 'hyperliquid-testnet',
    rpcChain: 'hyperliquid-testnet',
    chainIdentifier: 'hyperliquid-testnet',
    chainId: 998,
    networkTag: 'HYPT',
    relayAuthNetworkTag: 'MONT',
    emitWalletSync: async () => undefined,
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        relayAuth: expect.objectContaining({
          chain: 'hyperliquid-testnet',
          networkTag: 'MONT',
          customer: wallet.identity.address.raw,
        }),
      }),
    )
    expect(wallet.chainIdentifier).toBe('hyperliquid-testnet')
  } finally {
    await wallet.close()
  }
})

test('close drains an in-flight native operation and rejects further work', async () => {
    const chain = createEvmChain({
      ...config,
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
    const send = wallet.sendLegacy!({
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
      wallet.sendLegacy!({ recipient: { raw: expected[1].main }, value: 1n }),
    ).rejects.toThrow('closed')
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(destroyHttp).not.toHaveBeenCalled()
    release()
    // The Send was signed and recorded before close; a closing wallet hands it to nobody. It
    // stays retained, signed and unexposed, for recovery after the next open.
    let settledBeforeDestroy = false
    const outcome = await send.then(
      value => ({ value }),
      (error: unknown) => {
        settledBeforeDestroy = destroyHttp.mock.calls.length === 0
        return { error }
      },
    )
    await close
    expect(settledBeforeDestroy).toBe(true)
    const error = 'error' in outcome ? outcome.error : undefined
    expect(error).toBeInstanceOf(LegacyTransactionSetPendingError)
    const retained = (error as LegacyTransactionSetPendingError).operation
    expect(retained.cancelled).toBe(false)
    expect(retained.members.map(member => member.signed?.transactionHash)).toEqual([
      signedHash,
    ])
    expect(retained.members.every(member => !member.exposed)).toBe(true)
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(destroyHttp).toHaveBeenCalledTimes(1)
})

test('cached callers share one durable owner, and a second Send spends another coin while the first is held', async () => {
  const chain = createEvmChain({
    ...config,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const [first, second] = await Promise.all([
    chain.createWallet(roots()),
    chain.createWallet(roots()),
  ])
  expect(first).toBe(second)
  const identity = (first as EvmChainWalletHandle).nativeSources!.identity.address.raw.toLowerCase()
  const main = expected[0].main.toLowerCase()
  const rpc = mockNativeRpc(first as EvmChainWalletHandle, {
    [main]: 100000n,
    [identity]: 100000n,
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
    const a = first.sendLegacy!({
      recipient: { raw: expected[1].main },
      value: 1n,
      onSigned: async () => {
        started()
        await gate
      },
    })
    await entered
    // The first Send holds only its own coin: the second is built, signed and broadcast from the
    // other coin while the first still waits.
    const b = await second.sendLegacy!({
      recipient: { raw: expected[1].main },
      value: 2n,
    })
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    release()
    const sentA = await a
    // Both are complete (and so archived): what the node received is the evidence.
    const sourceOf = (txHash: string) =>
      Transaction.from(
        rpc.broadcast.mock.calls.find(([raw]) => Transaction.from(raw).hash === txHash)![0],
      ).from!.toLowerCase()
    expect(new Set([sourceOf(sentA.txHash), sourceOf(b.txHash)])).toEqual(
      new Set([main, identity]),
    )
    expect(
      rpc.broadcast.mock.calls.map(([raw]) => Transaction.from(raw).nonce),
    ).toEqual([0, 0])
  } finally {
    release?.()
    await first.close()
  }
})

test(
  'snapshots sendLegacy authorization before the public wallet queue',
  async () => {
    const chain = createEvmChain(config)
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    // Two coins: the first Send holds one while the second is built from the other.
    const rpc = mockNativeRpc(wallet, {
      [expected[0].main]: 500000n,
      [wallet.nativeSources!.identity.address.raw]: 500000n,
    })
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
      const first = wallet.sendLegacy!({
        recipient: { raw: expected[1].main },
        value: 1000n,
        onSigned: async () => {
          entered()
          await wait
        },
      })
      await started
      const params = { recipient: { raw: expected[1].main }, value: 100000n }
      const second = wallet.sendLegacy!(params)
      params.recipient.raw = expected[1].auth
      params.value = 150000n
      release()
      const [, sent] = await Promise.all([first, second])
      const tx = Transaction.from(
        rpc.broadcast.mock.calls.find(([raw]) => Transaction.from(raw).hash === sent.txHash)![0],
      )
      expect(tx.to).toBe(expected[1].main)
      expect(tx.value).toBe(100000n)
    } finally {
      release?.()
      await wallet.close()
    }
  },
)

test('snapshots sendLegacy authorization before shared inventory refresh', async () => {
  const chain = createEvmChain(config)
  const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  const rpc = mockNativeRpc(wallet, { [expected[0].main]: 500000n })
  jest.spyOn(wallet.provider, 'getBlockNumber').mockResolvedValue(1)
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
  const readBalance = jest.mocked(wallet.provider.getBalance).getMockImplementation()!
  jest.mocked(wallet.provider.getBalance).mockImplementationOnce(async (...args) => {
    entered()
    await wait
    return readBalance(...args)
  })
  let sending: ReturnType<NonNullable<EvmChainWalletHandle['sendLegacy']>> | undefined
  try {
    const params = { recipient: { raw: expected[1].main }, value: 100000n }
    sending = wallet.sendLegacy!(params)
    await started
    expect(rpc.broadcast).not.toHaveBeenCalled()
    params.recipient.raw = expected[1].auth
    params.value = 150000n
    release()
    const sent = await sending
    // Complete, and so archived: the payment the node received is the evidence.
    const raw = rpc.broadcast.mock.calls.find(
      ([candidate]) => Transaction.from(candidate).hash === sent.txHash,
    )![0]
    const tx = Transaction.from(raw)
    expect(tx.to).toBe(expected[1].main)
    expect(tx.value).toBe(100000n)
  } finally {
    release?.()
    await sending?.catch(() => undefined)
    await wallet.close()
  }
})

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
      const originalOperations = wallet.getNativeOperations!()
      jest
        .spyOn(wallet.provider, 'getNetwork')
        .mockResolvedValue(Network.from(10143))
      const ActualSigner = jest.requireActual<
        typeof import('../evm-account-tx')
      >('../evm-account-tx').MonadAccountTxSigner
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
        jest.spyOn(wallet.provider, 'getBlockNumber').mockResolvedValue(1)
        const signed = jest.fn(async () => undefined)
        await expect(
          wallet.sendLegacy!({
            recipient: { raw: expected[1].main },
            value: 100000n,
            onSigned: signed,
          }),
        ).rejects.toThrow('Insufficient available EVM coins')
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
  await mkdir(join(dir, `wallet-${config.networkId}-evm-${expected[0].main.toLowerCase()}`))
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
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD)
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
    { typeId: TYPE_DIRECT_MESSAGE_DELIVERY, schemaVersion: 1, minReaderVersion: 1 },
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
            [0, wire.network],
            [1, getBytes(Transaction.from(raw).hash!)],
            [2, new Uint8Array(32).map((_, i) => (i === 31 ? 1 : 0))],
            [3, fromHex(wire.destination)],
            [4, fromHex(wire.t4)],
            [7, 0],
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
  const storage = join(dir, `wallet-${config.networkId}-evm-${expected[0].main.toLowerCase()}`)
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
  const storage = join(dir, `wallet-${config.networkId}-evm-${expected[0].main.toLowerCase()}`)
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
    // The pool's own bookkeeping may retire the orphaned in-use row at startup; it never makes
    // the account leasable again, and it is not what holds the coin.
    expect(['in-use', 'retired']).toContain(second.pool.getRecord(0)!.status)
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
  await mkdir(join(dir, `wallet-${config.networkId}-evm-${expected[0].main.toLowerCase()}`))
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

test('construction failure after both clients exist destroys both providers', async () => {
  const providers = jest.spyOn(providerModule, 'createMonadJsonRpcProvider')
  // The first step after both clients are built: the coin list's store.
  jest.spyOn(coinStoreModule, 'MemoryRecordStore').mockImplementation(() => {
    throw new Error('fixture construction failure')
  })
  await expect(
    createEvmChain(config).createWallet({
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    }),
  ).rejects.toThrow('fixture construction failure')
  expect(providers.mock.results).toHaveLength(2)
  expect(providers.mock.results.every(result => result.value.destroyed)).toBe(
    true,
  )
})

test('a capability 401 from the relay is reported; the wallet asks nothing but the relay', async () => {
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
})

test.each([
  'main',
  'identity',
  'spend',
  'change',
  'identity-stealth-v1',
] as const)(
  'a %s coin whose Send failed before signing is spent after reopen through owned custody',
  async kind => {
    const dir = await mkdtemp(join(tmpdir(), 'frank-native-custody-'))
    const cfg = {
      ...config,
      walletStorageLocation: join(dir, 'wallet'),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      // A change account funded on chain is found by the seed walk, as on a restored device.
      ...(kind === 'change' ? { seedDiscovery: true } : {}),
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
        const { deriveEvmStealthPrivateKey } = await import('../evm-stealth')
        const ephemeral = new Wallet('0x' + '55'.repeat(32)).signingKey
          .compressedPublicKey
        const derived = deriveEvmStealthPrivateKey({
          recipientSpendSecret: first.identity.toPrivateKeyHex(),
          ephemeralPubKey: getBytes(ephemeral),
        })
        sourceAddress = derived.stealthAddress
        await first.recordStealthPayment({
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: ephemeral.slice(2),
          transactions: [],
          amount: 100000,
        })
      }
      const rpc = mockNativeRpc(first, { [sourceAddress]: 100000n })
      // A received coin is a source once the chain shows it funded.
      if (kind === 'identity-stealth-v1') await first.refreshReceivedPayments!()
      // Construction signs the whole set before anything is recorded: a signature that fails
      // leaves no operation and no held coin.
      const cannotSign = jest
        .spyOn(SigningKey.prototype, 'sign')
        .mockImplementationOnce(() => {
          throw new Error('interrupted before signature')
        })
      await expect(
        first.sendLegacy!({
          recipient: { raw: expected[1].main },
          value: 1000n,
        }),
      ).rejects.toThrow('interrupted before signature')
      cannotSign.mockRestore()
      expect(rpc.broadcast).not.toHaveBeenCalled()
      expect(
        first.getNativeOperations!().filter(row => !row.cancelled),
      ).toEqual([])
      expect(
        evmWalletInternals(first).coinList!.isAccountReserved(sourceAddress),
      ).toBe(false)
      await first.close()
      second = (await createEvmChain(cfg).createWallet(
        roots(),
      )) as EvmChainWalletHandle
      if (kind === 'identity-stealth-v1')
        expect(
          second
            .getReceivedPayments!()
            .some(
              a => a.address === sourceAddress.toLowerCase() && a.spendable,
            ),
        ).toBe(true)
      const recovered = mockNativeRpc(second, { [sourceAddress]: 100000n })
      // After the reopen the coin is spent through the wallet's own key for it.
      const sent = await second.sendLegacy!({
        recipient: { raw: expected[1].main },
        value: 1000n,
      })
      const tx = Transaction.from(recovered.broadcast.mock.calls[0]![0])
      expect(tx.from).toBe(sourceAddress)
      expect(tx.hash).toBe(sent.txHash)
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
    expect(() =>
      wallet.nativeSources!.resolveSource({
        kind: 'coin',
        address: stranger.address.toLowerCase(),
      }),
    ).toThrow('Native source is not a coin of this wallet')
    expect(() =>
      wallet.nativeSources!.resolveSource({
        kind: 'spend',
        address: stranger.address.toLowerCase(),
        index: 0,
      }),
    ).toThrow('Native custody source address mismatch')
    const rpc = mockNativeRpc(wallet, { [stranger.address]: 100000n })
    await expect(
      wallet.sendLegacy!({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('Insufficient')
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(
      Object.values(evmWalletInternals(wallet).coinList?.all() ?? []).filter(
        coin => coin.holder !== undefined,
      ),
    ).toEqual([])
  } finally {
    await wallet.close()
  }
})

test('a Send of a pool account coin holds that coin while its broadcast is unanswered and across reopen; once included the residual is spendable at the next nonce, and its note applied twice changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-pool-coin-send-'))
  const emitWalletSync = jest.fn(async () => undefined)
  const cfg: EvmChainConfig = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    emitWalletSync,
  }
  const pool = expected[0].pool.toLowerCase()
  const coinsOf = (wallet: EvmChainWalletHandle) =>
    evmWalletInternals(wallet).coinList!
  const snapshot = (wallet: EvmChainWalletHandle) =>
    JSON.stringify(coinsOf(wallet).all(), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
  let first: EvmChainWalletHandle | undefined
  let second: EvmChainWalletHandle | undefined
  try {
    first = (await createEvmChain(cfg).createWallet(roots())) as EvmChainWalletHandle
    // Only pool account 0 holds anything.
    const rpc = mockNativeRpc(first, { [pool]: 200000n })
    rpc.broadcast.mockRejectedValueOnce(new Error('reply lost'))
    await expect(
      first.sendLegacy!({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('retained pending')
    const row = first.getNativeOperations!()[0]!
    expect(row.kind).toBe('transaction-set')
    expect(row.members.map(member => member.source)).toEqual([
      { kind: 'coin', address: pool },
    ])
    const signed = row.members[0]!.signed!
    // Held by the unanswered Send: not unspent, reserved, and no other Send can take it.
    expect(coinsOf(first).get(pool, 0)?.state).not.toBe('unspent')
    expect(coinsOf(first).isAccountReserved(pool)).toBe(true)
    await expect(
      first.sendLegacy!({ recipient: { raw: expected[1].main }, value: 1000n }),
    ).rejects.toThrow('Insufficient available EVM coins')
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    await first.close()

    second = (await createEvmChain(cfg).createWallet(roots())) as EvmChainWalletHandle
    const recovered = mockNativeRpc(second, { [pool]: 200000n })
    // Still held after the reopen, by the same retained operation.
    expect(coinsOf(second).isAccountReserved(pool)).toBe(true)
    expect(second.getUnresolvedLegacySend!().map(op => op.operationId)).toEqual([
      row.operationId,
    ])
    const resumed = await second.resumeLegacySend!(row.operationId)
    expect(resumed.txHash).toBe(signed.transactionHash)
    expect(recovered.broadcast.mock.calls.map(([raw]) => raw)).toEqual([
      signed.rawTransaction,
    ])
    // The residual (200000 - 1000 - 21000 fee) is the same account's coin at nonce 1.
    expect(coinsOf(second).get(pool, 1)).toMatchObject({
      state: 'unspent',
      valueWei: 178000n,
    })
    const next = await second.sendLegacy!({
      recipient: { raw: expected[1].main },
      value: 2000n,
    })
    const nextTx = Transaction.from(recovered.broadcast.mock.calls[1]![0])
    expect(nextTx.hash).toBe(next.txHash)
    expect(nextTx.from!.toLowerCase()).toBe(pool)
    expect(nextTx.nonce).toBe(1)

    // The note this device wrote about the first Send, applied back here twice: nothing changes.
    await second.flushNativeSync!()
    const note = (emitWalletSync.mock.calls as unknown as Array<[WalletSyncItem]>)
      .map(([item]) => item)
      .find(item => item.txHash === signed.transactionHash)!
    expect(note).toMatchObject({ chainIdentifier: 'monad-testnet', rawTx: signed.rawTransaction })
    const before = snapshot(second)
    await applyWalletSyncItem(second, note)
    await applyWalletSyncItem(second, note)
    expect(snapshot(second)).toEqual(before)
    expect(recovered.broadcast).toHaveBeenCalledTimes(2)
  } finally {
    await second?.close()
    await first?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('close during a Send\'s coin refresh: the Send signs, records and broadcasts nothing, and close completes', async () => {
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
  // The Send's coin-list refresh reads the chain before anything is selected or signed.
  const readBalance = jest.mocked(wallet.provider.getBalance).getMockImplementation()!
  jest.mocked(wallet.provider.getBalance).mockImplementationOnce(async (...args) => {
    entered()
    await wait
    return readBalance(...args)
  })
  try {
    const send = wallet.sendLegacy!({
      recipient: { raw: expected[1].main },
      value: 1000n,
    })
    await started
    const close = wallet.close()
    expect(rpc.broadcast).not.toHaveBeenCalled()
    release()
    // Close ends the refresh: the Send selects from nothing it has read, so it refuses with
    // nothing signed, recorded or broadcast, and close completes.
    await expect(send).rejects.toThrow()
    await close
    expect(rpc.broadcast).not.toHaveBeenCalled()
    expect(
      Object.values(evmWalletInternals(wallet).coinList?.all() ?? []).filter(
        coin => coin.holder !== undefined,
      ),
    ).toEqual([])
  } finally {
    release?.()
    await wallet.close()
  }
})

test('conflicting recovered owners remain read-only, and reopening builds and submits nothing', async () => {
  const bundleModule = jest.requireActual(
    '../storage/evm-wallet-bundle',
  ) as typeof import('../storage/evm-wallet-bundle')
  const originalOpen = bundleModule.openExistingPoolEvmWalletBundle
  let lastBundle: Awaited<ReturnType<typeof originalOpen>> | undefined
  jest
    .spyOn(bundleModule, 'openExistingPoolEvmWalletBundle')
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
      wallet.sendLegacy!({
        recipient: { raw: expected[1].main },
        value: 1n,
        onSigned: async () => {
          throw new Error('fixture signed, never exposed')
        },
      }),
    ).rejects.toThrow('retained pending')
    const nativeBefore = wallet.getNativeOperations!()
    expect(nativeBefore).toHaveLength(1)
    expect(nativeBefore[0].cancelled).toBe(false)
    expect(nativeBefore[0].members[0]!.signed).not.toBeNull()
    expect(nativeBefore[0].members[0]!.exposed).toBe(false)
    jest
      .spyOn(wallet.provider, 'getNetwork')
      .mockResolvedValue(Network.from(10143))
    const ActualSigner = jest.requireActual(
      '../evm-account-tx',
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
// A contract call is the native journal's own operation from the main account (a Send is a
// transaction set of the coin list). Its never-signed plan is cancelled by the call that failed,
// and its broadcast member is re-observed by the hosts' poll within fixed bounds.
// -------------------------------------------------------------------------------------------
const CALL = {
  to: { raw: '0x000000000000000000000000000000000000dEaD' },
  data: '0x12345678',
  value: 0n,
  gasLimit: 50_000n,
}

test('signing throws for a contract call: the call throws its own error, its plan is cancelled in that call and retained, and a second call from main takes the same nonce', async () => {
  const wallet = (await createEvmChain(config).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  try {
    const rpc = mockNativeRpc(wallet, { [expected[0].main]: 500000n })
    const sign = jest
      .spyOn(Wallet.prototype, 'signTransaction')
      .mockRejectedValueOnce(new Error('fixture: signer unavailable'))
    await expect(wallet.sendContractCall!(CALL)).rejects.toThrow(
      'fixture: signer unavailable',
    )
    sign.mockRestore()
    const [plan] = wallet.getNativeOperations!()
    expect(plan).toMatchObject({
      kind: 'contract',
      cancelled: true,
      members: [
        {
          source: { kind: 'main', address: expected[0].main.toLowerCase() },
          signed: null,
          exposed: false,
        },
      ],
    })
    expect(rpc.broadcast).not.toHaveBeenCalled()
    const second = await wallet.sendContractCall!(CALL)
    const operations = wallet.getNativeOperations!()
    expect(operations[0]).toEqual(plan)
    expect(rpc.broadcast).toHaveBeenCalledTimes(1)
    const sent = Transaction.from(rpc.broadcast.mock.calls[0]![0])
    expect(sent.hash).toBe(second.txHash)
    expect(sent.from).toBe(expected[0].main)
    // The cancelled plan's nonce was never consumed: the second call uses it.
    expect(sent.nonce).toBe(
      Transaction.from(plan!.members[0]!.unsignedTransaction).nonce,
    )
  } finally {
    await wallet.close()
  }
})

describe('bounded re-observation of a broadcast contract call (#1235 Stage 3)', () => {
  /** The consolidator's clock is `Date.now` in composition: moved here, never slept on. */
  const clock = () => {
    const real = Date.now.bind(Date)
    let ahead = 0
    jest.spyOn(Date, 'now').mockImplementation(() => real() + ahead)
    return { advance: (ms: number) => void (ahead += ms) }
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const wallets: EvmChainWalletHandle[] = []
  afterEach(async () => {
    for (const opened of wallets.splice(0))
      await opened.close().catch(() => undefined)
  })
  /** A wallet whose contract call the node keeps, unmined, until `withhold(false)`. One warm-up
   * tick records it `pending`; the clock is then past the pass floor and the member's wait. */
  const pendingCall = async (time: ReturnType<typeof clock>) => {
    const wallet = (await createEvmChain(config).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    wallets.push(wallet)
    const identity = wallet.nativeSources!.identity.address.raw
    const rpc = mockNativeRpc(wallet, {
      [expected[0].main]: 500000n,
      [identity]: 500000n,
    })
    let withheldHash: string | undefined
    let withholdAll = true
    const held = (hash: string) => withholdAll || hash === withheldHash
    const receipt = jest.mocked(wallet.provider.getTransactionReceipt)
    const visibleReceipt = receipt.getMockImplementation()!
    receipt.mockImplementation(async hash =>
      held(hash) ? null : visibleReceipt(hash),
    )
    const transaction = jest.mocked(wallet.provider.getTransaction)
    const visibleTransaction = transaction.getMockImplementation()!
    transaction.mockImplementation(async hash => {
      const found = await visibleTransaction(hash)
      // Known to the node, not yet in a block.
      return found && held(hash)
        ? (Transaction.from(
            (found as unknown as Transaction).serialized,
          ) as unknown as TransactionResponse)
        : found
    })
    const sent = await wallet.sendContractCall!(CALL)
    withholdAll = false
    withheldHash = sent.txHash
    const member = () =>
      wallet
        .getNativeOperations!()
        .find(row => row.kind === 'contract')!.members[0]!
    expect(member().signed!.transactionHash).toBe(sent.txHash)
    expect(member().exposed).toBe(true)
    await wallet.reobserveNativeOperations!()
    time.advance(15_000)
    expect(member().observation.state).toBe('pending')
    return {
      wallet,
      rpc,
      receipt,
      member,
      sent,
      identity,
      withhold: (value: boolean) => void (withheldHash = value ? sent.txHash : undefined),
      /** Receipt lookups for the call, from now on. */
      probes: () =>
        receipt.mock.calls.filter(([hash]) => hash === sent.txHash).length,
    }
  }

  test('a pending call costs one bounded lookup and one lost-broadcast look per tick, each waiting at least 15 s; once included, later ticks ask nothing', async () => {
    const time = clock()
    const f = await pendingCall(time)
    const before = f.wallet.getNativeOperations!()
    f.receipt.mockClear()
    await f.wallet.reobserveNativeOperations!()
    // The bounded lookup, and the contract call's own look for a lost broadcast: one receipt
    // request each.
    expect(f.probes()).toBe(2)
    // Nothing learned: nothing written.
    expect(f.wallet.getNativeOperations!()).toEqual(before)
    // Inside the waits and the pass floor: nothing more, however many ticks.
    await Promise.all(
      Array.from({ length: 20 }, () => f.wallet.reobserveNativeOperations!()),
    )
    time.advance(14_000)
    await f.wallet.reobserveNativeOperations!()
    expect(f.probes()).toBe(2)
    // Each look that learned nothing waits longer (doubling); a later tick looks again, and no
    // tick ever asks more than once per look.
    for (let i = 0; i < 6; i++) {
      const asked = f.probes()
      time.advance(60_000)
      await f.wallet.reobserveNativeOperations!()
      expect(f.probes() - asked).toBeLessThanOrEqual(2)
    }
    expect(f.probes()).toBeGreaterThan(2)
    expect(f.wallet.getNativeOperations!()).toEqual(before)
    // The receipt appears: one tick records the inclusion, signing and broadcasting nothing.
    f.withhold(false)
    const sign = jest.spyOn(Wallet.prototype, 'signTransaction')
    const digest = jest.spyOn(SigningKey.prototype, 'sign')
    f.rpc.broadcast.mockClear()
    // Past the longest wait (`REOBSERVE_MAX_BACKOFF_MS`).
    time.advance(600_000)
    await f.wallet.reobserveNativeOperations!()
    expect(f.member().observation).toMatchObject({
      state: 'included-success',
      transactionHash: f.sent.txHash,
    })
    expect(sign).not.toHaveBeenCalled()
    expect(digest).not.toHaveBeenCalled()
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
    // Terminal: later ticks ask nothing about it.
    f.receipt.mockClear()
    for (let i = 0; i < 20; i++) {
      time.advance(600_000)
      await f.wallet.reobserveNativeOperations!()
    }
    expect(f.probes()).toBe(0)
  })

  test('a node that never answers the probe: a Send completes meanwhile, the wallet closes without waiting for the node, and an answer after close records nothing and rejects nothing', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const f = await pendingCall(clock())
      const operation = f.wallet
        .getNativeOperations!()
        .find(row => row.kind === 'contract')!
      let answer!: (receipt: null) => void
      f.receipt.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            answer = resolve
          }),
      )
      let returned = false
      const tick = f.wallet.reobserveNativeOperations!().then(() => {
        returned = true
      })
      await settle()
      expect(answer).toBeDefined()
      // A second tick while the first is in flight starts nothing and returns at once.
      await f.wallet.reobserveNativeOperations!()
      // A Send of another coin is not held behind the unanswered lookup.
      const sent = await f.wallet.sendLegacy!({
        recipient: { raw: expected[1].main },
        value: 1000n,
      })
      const sentTx = Transaction.from(
        f.rpc.broadcast.mock.calls.find(
          ([raw]) => Transaction.from(raw).hash === sent.txHash,
        )![0],
      )
      expect(sentTx.from!.toLowerCase()).toBe(f.identity.toLowerCase())
      expect(returned).toBe(false)
      await f.wallet.close()
      await tick
      answer(null)
      await settle()
      await settle()
      expect(operation.members[0]!.observation.state).not.toBe('included-success')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('a lookup deadline ends the tick and leaves the call exactly as it was', async () => {
    const f = await pendingCall(clock())
    const before = f.wallet.getNativeOperations!()
    f.receipt.mockImplementationOnce(() => new Promise(() => undefined))
    jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'nextTick'] })
    try {
      const tick = f.wallet.reobserveNativeOperations!()
      await settle()
      await jest.advanceTimersByTimeAsync(30_000)
      await tick
      expect(f.wallet.getNativeOperations!()).toEqual(before)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a closed wallet: the method resolves, asks nothing and writes nothing', async () => {
    const f = await pendingCall(clock())
    f.withhold(false)
    await f.wallet.close()
    f.receipt.mockClear()
    f.rpc.broadcast.mockClear()
    await expect(f.wallet.reobserveNativeOperations!()).resolves.toBeUndefined()
    expect(f.receipt).not.toHaveBeenCalled()
    expect(f.rpc.broadcast).not.toHaveBeenCalled()
  })
})

/** Synthetic RPC, real custody/wallet/journals and app helpers. No live relay or chain. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Interface,
  Transaction,
  keccak256,
  type Block,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'
import { activeChain, type NativeWalletHandle } from '@frank/wallet/chain'
import { createEvmChain } from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { getEvmDexDeployment } from '@frank/wallet/chain/dex-deployments'
import { fixedStampDefault } from '@frank/wallet/oracle/stamp-policy.testutil'
import vectors from '../../../packages/domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '@frank/domain-roots'
import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import type { StealthPaymentAsset } from '@frank/wallet/stealth-payment'
import {
  encodeFrame,
  standaloneItemBudget,
  validateFrame,
  type Encodable,
} from '@frank/codec'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'
import {
  decodeItemFrames,
  encodeItemFrames,
} from '@frank/wallet/message-item-plugins/wire'
import { configuredStealthAssets } from './configured-assets'
import {
  reviewStealthPayment,
  sendReviewedStealthPayment,
} from './review-payment'
import { captureOutgoingFinancialOperations } from './outgoing'
import { createFinancialOperationRecovery } from './recovery'
import {
  groupRecipientAssetPayment,
  recordRecipientAssetPayment,
} from './receive'

let mockMessagingWallet: EvmChainWalletHandle
let mockFinancialWallet: NativeWalletHandle
const mockSession = { status: 'ready', account: {}, revision: 1 }
// The subprocess replaces only these two app composition modules, as Jest does above.
if (process.env.FRANK_COMPOSED_SDK_CHILD === '1') {
  Object.defineProperty(globalThis, '__composedPaymentBridge', {
    value: {
      get session() {
        return mockSession
      },
      get messaging() {
        return mockMessagingWallet
      },
      get financial() {
        return mockFinancialWallet
      },
    },
  })
}

jest.mock('../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockSession
    },
    getWallet: async () => mockMessagingWallet,
  },
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: async (chainIdentifier: string) => ({
    captureWallet: async () => {
      if (mockFinancialWallet.chainIdentifier !== chainIdentifier)
        throw new Error('Wrong composed financial owner')
      const wallet = mockFinancialWallet
      return {
        wallet,
        assertCurrent: async () => {
          if (mockFinancialWallet !== wallet) throw new Error('Owner replaced')
        },
      }
    },
  }),
}))

const MAIN = '0x4669eff913a3c595cea5fa92a600201e8e9e75d8'
const token = getEvmDexDeployment('monad-testnet')!.tokens.find(
  t => t.symbol === 'USDC',
)!.address!
const abi = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
function roots(variant = 0): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: Uint8Array.from(
      Buffer.from(vectors.vectors[0].outputs[purpose], 'hex'),
      b => b ^ variant,
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
function configuration(path: string): EvmChainConfig {
  return {
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    networkTag: 'MONT',
    chainId: 10143,
    relayBaseUrl: 'http://127.0.0.1:1',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    resolveDefaultStamp: fixedStampDefault(1n),
    defaultTopicVoteValueWei: 1n,
    subAccountPoolSize: 0,
    nativeInclusionWaitMs: 0,
    walletStorageLocation: path,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
}
/** Only node responses are synthetic; no wallet financial method is replaced. */
function node() {
  const balances = new Map([[MAIN, 1_000_000_000n]])
  const tokens = new Map([[MAIN, 50_000_000n]])
  const receipts = new Map<string, TransactionReceipt>()
  const transactions = new Map<string, TransactionResponse>()
  const broadcasts: string[] = []
  const blockHash = '0x' + 'ab'.repeat(32)
  let ambiguous = false
  const attach = (wallet: EvmChainWalletHandle) => {
    const p = wallet.provider
    jest
      .spyOn(p, 'getBlock')
      .mockResolvedValue({ number: 1, hash: blockHash } as Block)
    jest.spyOn(p, 'getBlockNumber').mockResolvedValue(1)
    jest
      .spyOn(p, 'getBalance')
      .mockImplementation(
        async a => balances.get(String(a).toLowerCase()) ?? 0n,
      )
    jest.spyOn(p, 'getTransactionCount').mockResolvedValue(0)
    jest.spyOn(p, 'getFeeData').mockResolvedValue({
      gasPrice: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    } as never)
    jest.spyOn(p, 'estimateGas').mockResolvedValue(21_000n)
    jest
      .spyOn(p, 'getTransaction')
      .mockImplementation(async hash => transactions.get(hash) ?? null)
    jest
      .spyOn(p, 'getTransactionReceipt')
      .mockImplementation(async hash => receipts.get(hash) ?? null)
    jest.spyOn(p, 'call').mockImplementation(async request => {
      if (String(request.to).toLowerCase() !== token.toLowerCase())
        throw new Error('Unexpected token RPC')
      const [owner] = abi.decodeFunctionData(
        'balanceOf',
        request.data as string,
      )
      return abi.encodeFunctionResult('balanceOf', [
        tokens.get(String(owner).toLowerCase()) ?? 0n,
      ])
    })
    jest.spyOn(p, 'broadcastTransaction').mockImplementation(async raw => {
      broadcasts.push(raw)
      if (ambiguous) {
        ambiguous = false
        throw new Error('Simulated reply lost')
      }
      return { hash: keccak256(raw) } as TransactionResponse
    })
  }
  const mine = (raw: string) => {
    const tx = Transaction.from(raw),
      from = tx.from!.toLowerCase()
    balances.set(
      from,
      (balances.get(from) ?? 0n) - tx.value - tx.gasLimit * tx.maxFeePerGas!,
    )
    const logs: TransactionReceipt['logs'][number][] = []
    if (tx.to!.toLowerCase() === token.toLowerCase()) {
      const [to, amount] = abi.decodeFunctionData('transfer', tx.data)
      tokens.set(
        String(to).toLowerCase(),
        (tokens.get(String(to).toLowerCase()) ?? 0n) + BigInt(amount),
      )
      logs.push({
        address: token,
        index: 0,
        ...abi.encodeEventLog(abi.getEvent('Transfer')!, [tx.from, to, amount]),
      } as unknown as TransactionReceipt['logs'][number])
    } else
      balances.set(
        tx.to!.toLowerCase(),
        (balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value,
      )
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
      gasUsed: tx.gasLimit,
      gasPrice: 1n,
      logs,
    } as unknown as TransactionReceipt)
  }
  return {
    attach,
    mine,
    broadcasts,
    loseNextReply: () => {
      ambiguous = true
    },
  }
}
function decodeRecipient(
  item: RecipientAssetPaymentItem,
): RecipientAssetPaymentItem {
  const registry = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  const frames = encodeItemFrames(registry, [item])
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
    throw new Error('Invalid composed item fixture')
  return decodeItemFrames(
    registry,
    revision.typed.items,
    standaloneItemBudget(),
  )[0] as RecipientAssetPaymentItem
}

afterEach(() => jest.restoreAllMocks())
test.each(['native', 'USDC'] as const)(
  'app review → real EVM %s owner → durable originals → recovery → recipient owner',
  async kind => {
    const dir = await mkdtemp(join(tmpdir(), 'frank-composed-app-'))
    const cfg = configuration(join(dir, 'sender'))
    let sender = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    const recipient = (await createEvmChain(
      configuration(join(dir, 'recipient')),
    ).createWallet(roots(1))) as EvmChainWalletHandle
    const rpc = node()
    rpc.attach(sender)
    rpc.attach(recipient)
    mockMessagingWallet = sender
    mockFinancialWallet = sender
    const publicKey = recipient.identity.compressedPubKey
    const asset: StealthPaymentAsset =
      kind === 'native'
        ? { kind: 'native' }
        : { kind: 'erc20', contractAddress: token }
    const amount = kind === 'native' ? 1_000n : 20_000_000n
    jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
      address: recipient.identity.address,
      pubKey: publicKey,
    })
    try {
      // All node calls remain unchanged while listing configured metadata.
      const rpcMethods = [
        'getBlock',
        'getBlockNumber',
        'getBalance',
        'getTransactionCount',
        'getFeeData',
        'estimateGas',
        'getTransaction',
        'getTransactionReceipt',
        'call',
        'broadcastTransaction',
      ] as const
      const callCounts = () =>
        rpcMethods.map(
          method => jest.mocked(sender.provider[method]).mock.calls.length,
        )
      const before = callCounts()
      const listed = await configuredStealthAssets()
      expect(
        listed.options.some(
          option =>
            option.chainIdentifier === 'monad-testnet' &&
            option.asset.kind === asset.kind,
        ),
      ).toBe(true)
      expect(callCounts()).toEqual(before)
      const review = await reviewStealthPayment({
        request: {
          address: recipient.identity.displayAddress,
          chainIdentifier: 'monad-testnet',
          assetKey: kind,
          asset,
          amountAtomic: amount,
          memo: 'exact recipient value',
        },
        stampValue: 0n,
        isCurrent: () => true,
      })
      expect(sender.getNativeOperations!()).toEqual([])
      expect(
        await sender.stealthPayments!.get(review.quote.operationId),
      ).toBeUndefined()
      expect(rpc.broadcasts).toEqual([])
      let item!: RecipientAssetPaymentItem
      let original!: string
      const digest = 'ab'.repeat(32)
      await expect(
        sendReviewedStealthPayment(
          review,
          'exact recipient value',
          async (prepared, projection) => {
            item = decodeRecipient(projection)
            original = prepared.members[0].rawTransaction
            const tx = Transaction.from(original)
            expect(tx.from!.toLowerCase()).toBe(MAIN)
            expect(tx.gasLimit * tx.maxFeePerGas!).toBeLessThanOrEqual(
              review.maxNativeFeeAtomic,
            )
            expect(
              prepared.members.reduce(
                (sum, member) => sum + member.recipientAmountAtomic,
                0n,
              ),
            ).toBe(amount)
            if (asset.kind === 'native') expect(tx.value).toBe(amount)
            else {
              expect(tx.to!.toLowerCase()).toBe(token.toLowerCase())
              expect(abi.decodeFunctionData('transfer', tx.data)[1]).toBe(
                amount,
              )
              expect(tx.value).toBe(0n)
            }
            const outgoing = await captureOutgoingFinancialOperations(sender, [
              {
                chainIdentifier: prepared.chainIdentifier,
                operationId: prepared.operationId,
              },
            ])
            await expect(outgoing.submit()).rejects.toThrow()
            expect(rpc.broadcasts).toEqual([])
            // Host seam: only a completed sealed-envelope durability callback authorizes exposure.
            let sealedDurable = false
            const onEnvelopeDurable = async (payloadDigest: string) => {
              if (!sealedDurable) throw new Error('Envelope not durable')
              await outgoing.expose(payloadDigest)
            }
            await expect(onEnvelopeDurable(digest)).rejects.toThrow(
              'not durable',
            )
            expect(await sender.stealthPayments!.list()).toEqual([
              { operationId: prepared.operationId },
            ])
            sealedDurable = true
            await onEnvelopeDurable(digest)
            throw new Error('Simulated outgoing interruption after adoption')
          },
        ),
      ).rejects.toThrow('after adoption')
      expect(
        await sender.stealthPayments!.release(review.quote.operationId),
      ).toBe(false)
      expect(await sender.stealthPayments!.list()).toEqual([
        { operationId: review.quote.operationId, payloadDigest: digest },
      ])
      await sender.close()
      sender = (await createEvmChain(cfg).createWallet(
        roots(),
      )) as EvmChainWalletHandle
      rpc.attach(sender)
      mockMessagingWallet = sender
      mockFinancialWallet = sender
      expect(
        (await sender.stealthPayments!.get(review.quote.operationId))!
          .members[0].rawTransaction,
      ).toBe(original)
      let delivered = false
      const failures: unknown[] = []
      const recovery = createFinancialOperationRecovery({
        captureSession: async () => ({
          isCurrent: () => true,
          wallets: [
            {
              owner: sender,
              chainIdentifier: 'monad-testnet',
              payments: sender.stealthPayments!,
            },
          ],
          deliveryOf: async () => (delivered ? 'delivered' : 'live'),
        }),
        onError: error => failures.push(error),
      })
      await recovery.tick()
      expect(rpc.broadcasts).toEqual([])
      delivered = true
      rpc.loseNextReply()
      await recovery.tick()
      await recovery.tick()
      expect(rpc.broadcasts.length).toBeGreaterThanOrEqual(2)
      expect(rpc.broadcasts.every(raw => raw === original)).toBe(true)
      rpc.mine(original)
      const group = groupRecipientAssetPayment(item, {
        payloadDigest: digest,
        spendPublicKey: publicKey,
      })
      expect(group.unsupported).toEqual([])
      expect(group.groups).toHaveLength(1)
      expect(group.groups[0].claim.amountAtomic).toBe(amount)
      expect(group.groups[0].claim.asset).toEqual(
        asset.kind === 'native'
          ? asset
          : { ...asset, contractAddress: token.toLowerCase() },
      )
      const received = await recordRecipientAssetPayment(item, {
        payloadDigest: digest,
        spendPublicKey: publicKey,
        assertCurrent: () => undefined,
        openWallet: async () => recipient,
      })
      expect(received).toEqual([{ index: 0, status: 'recorded' }])
      expect(
        await recipient.stealthReceipts!.observe(group.groups[0].claim),
      ).toMatchObject({
        status: 'succeeded',
        verifiedReceivedAmountAtomic: amount,
        spendability: kind === 'native' ? 'spendable' : 'needs-native-gas',
      })
    } finally {
      await sender.close()
      await recipient.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

test('app review and outgoing binding reach the actual eCash SDK without broadcasting before exposure', async () => {
  if (process.env.FRANK_COMPOSED_SDK_CHILD !== '1') {
    const tree = resolve(__dirname, '../../..')
    const output = execFileSync(
      process.execPath,
      ['-e', ecashNodeDriver, tree, __filename],
      {
        cwd: tree,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, FRANK_COMPOSED_SDK_CHILD: '1' },
      },
    )
    expect(output).toContain('PASS actual eCash app composition')
    return
  }
  const { secp256k1 } = await import('@noble/curves/secp256k1')
  const { sha256 } = await import('@noble/hashes/sha256')
  const { Wallet: SdkWallet } = await import('ecash-wallet')
  const { HdNode, Ecc, shaRmd160, Tx } = await import('ecash-lib')
  const { EcashWallet, ECASH_TESTNET_CHECKPOINT_HASH } = await import(
    '@frank/wallet/ecash-wallet'
  )
  const { EcashSdkBackend } = await import('@frank/wallet/ecash-sdk-backend')
  const { InMemoryEcashOperationStore } = await import(
    '@frank/wallet/ecash-operation-store'
  )
  const root = {
    registry: 'frank-domain-roots-v1' as const,
    purpose: 'ecash-bch-wallet' as const,
    bytes: new Uint8Array(32).fill(9),
  }
  const account = HdNode.fromSeed(root.bytes).derivePath("m/44'/1899'/0'")
  const pkh = Buffer.from(
    shaRmd160(account.derivePath('0/0').pubkey()),
  ).toString('hex')
  const publicKey = new Ecc().derivePubkey(new Uint8Array(32).fill(55))
  const coins = Array.from({ length: 3 }, (_, i) => ({
    outpoint: { txid: String(i + 1).repeat(64), outIdx: i },
    sats: 10_000n,
    blockHeight: 800_000,
    isCoinbase: false,
    isFinal: true,
  }))
  let mined = false
  const chronik = {
    proxyInterface: () => ({
      getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }],
    }),
    blockchainInfo: async () => ({
      tipHeight: 900_000,
      tipHash: 'fa'.repeat(32),
    }),
    batchSummary: async (scripts: { payload: string }[]) =>
      scripts.map(s => ({
        numTxs: s.payload === pkh ? 1 : 0,
        numUtxos: s.payload === pkh ? coins.length : 0,
      })),
    batchUtxos: async (scripts: { payload: string }[]) =>
      scripts.map(s => ({
        utxos: {
          outputScript: '76a914' + s.payload + '88ac',
          utxos: s.payload === pkh ? coins : [],
        },
      })),
    script: (_type: string, payload: string) => ({
      utxos: async () => {
        const script = '76a914' + payload + '88ac'
        return {
          outputScript: script,
          utxos: mined
            ? [...new Set(sent.flat())].flatMap(raw => {
                const tx = Tx.fromHex(raw)
                return tx.outputs.flatMap((o, i) =>
                  o.script.toHex() === script
                    ? [
                        {
                          outpoint: { txid: tx.txid(), outIdx: i },
                          sats: o.sats,
                          blockHeight: 800000,
                          isCoinbase: false,
                          isFinal: true,
                        },
                      ]
                    : [],
                )
              })
            : [],
        }
      },
    }),
    block: async (height: number) => ({
      blockInfo: { height, hash: 'bc'.repeat(32) },
    }),
    tx: async (hash: string) => {
      const raw = sent.flat().find(raw => {
        const tx = Tx.fromHex(raw)
        return tx.txid() === hash
      })
      if (!raw) throw Error('Fixture transaction absent')
      const tx = Tx.fromHex(raw)
      return {
        txid: hash,
        ...(mined ? { block: { height: 800000, hash: 'bc'.repeat(32) } } : {}),
        outputs: tx.outputs.map(o => ({
          sats: o.sats,
          outputScript: o.script.toHex(),
        })),
      }
    },
    rawTx: async () => ({ rawTx: sent[0][0] }),
    broadcastTx: async () => {
      throw new Error('Unexpected Chronik broadcast')
    },
  }
  const store = new InMemoryEcashOperationStore(),
    sent: string[][] = []
  const open = (domainRoot = root, operationStore = store) =>
    EcashWallet.fromDomainRoot({
      domainRoot,
      networkId: 'xec-testnet',
      chronik: chronik as never,
      operationStore,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      checkpointClientFactory: () =>
        ({
          block: async () => ({
            blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
          }),
        } as never),
      rebroadcast: async raws => {
        sent.push([...raws])
      },
      walletFactory: ({ chronik: client, addressPrefix }) => {
        const account = HdNode.fromSeed(domainRoot.bytes).derivePath(
          "m/44'/1899'/0'",
        )
        const sdk = Reflect.construct(SdkWallet, [
          account.seckey(),
          client,
          account,
          0,
          addressPrefix,
        ]) as import('@frank/wallet/ecash-sdk-backend').EcashSdkWallet
        return new EcashSdkBackend(sdk, client, addressPrefix, {
          identityPublicKey: Buffer.from(publicKey).toString('hex'),
          assertActive: () => undefined,
          withDerivedStealthSecret: async (derivation, callback) => {
            const shared = sha256(
              secp256k1.getSharedSecret(
                new Uint8Array(32).fill(55),
                Buffer.from(derivation.ephemeralPubKey, 'hex'),
                true,
              ),
            )
            const scalar =
              (BigInt(
                '0x' + Buffer.from(new Uint8Array(32).fill(55)).toString('hex'),
              ) +
                BigInt('0x' + Buffer.from(shared).toString('hex'))) %
              secp256k1.CURVE.n
            shared.fill(0)
            const secret = Uint8Array.from(
              Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex'),
            )
            callback(secret)
            expect(secret.every(b => b === 0)).toBe(true)
          },
        })
      },
    })
  const dir = await mkdtemp(join(tmpdir(), 'frank-composed-ecash-message-'))
  const messaging = (await createEvmChain(
    configuration(join(dir, 'message')),
  ).createWallet(roots())) as EvmChainWalletHandle
  node().attach(messaging)
  mockMessagingWallet = messaging
  let financial = await open()
  mockFinancialWallet = financial
  jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
    address: messaging.identity.address,
    pubKey: publicKey,
  })
  try {
    const review = await reviewStealthPayment({
      request: {
        address: messaging.identity.displayAddress,
        chainIdentifier: 'xec-testnet',
        assetKey: 'xec',
        asset: { kind: 'native' },
        amountAtomic: 1_000n,
        memo: '',
      },
      stampValue: 0n,
      isCurrent: () => true,
    })
    expect(financial.getEcashOperations()).toEqual([])
    expect(sent).toEqual([])
    let raw!: string, item!: RecipientAssetPaymentItem
    await sendReviewedStealthPayment(
      review,
      undefined,
      async (prepared, projection) => {
        raw = prepared.members[0].rawTransaction
        const tx = Tx.fromHex(raw)
        const operation = financial
          .getEcashOperations()
          .find(op => op.operationId === prepared.operationId)!
        const actualFee =
          operation.inputs.reduce(
            (sum, input) => sum + BigInt(input.satoshis),
            0n,
          ) - tx.outputs.reduce((sum, output) => sum + output.sats, 0n)
        expect(actualFee).toBe(BigInt(operation.fee))
        expect(actualFee).toBeLessThanOrEqual(review.maxNativeFeeAtomic)
        expect(tx.outputs[prepared.members[0].vout!].sats).toBe(1_000n)
        expect(
          Buffer.from(tx.outputs[prepared.members[0].vout!].script.bytecode),
        ).toEqual(Buffer.from(prepared.recipientDestination))
        const decoded = (item = decodeRecipient(projection))
        const grouped = groupRecipientAssetPayment(decoded, {
          payloadDigest: 'cd'.repeat(32),
          spendPublicKey: publicKey,
        })
        expect(grouped.groups[0].claim).toMatchObject({
          asset: { kind: 'native' },
          amountAtomic: 1_000n,
          rawTransactions: [raw],
        })
        const outgoing = await captureOutgoingFinancialOperations(messaging, [
          { chainIdentifier: 'xec-testnet', operationId: prepared.operationId },
        ])
        await expect(outgoing.submit()).rejects.toThrow()
        expect(sent).toEqual([])
        await outgoing.expose('cd'.repeat(32))
        await outgoing.submit()
      },
    )
    expect(
      await financial.stealthPayments.release(review.quote.operationId),
    ).toBe(false)
    financial = await open()
    mockFinancialWallet = financial
    const recovery = createFinancialOperationRecovery({
      captureSession: async () => ({
        isCurrent: () => true,
        wallets: [
          {
            owner: financial,
            chainIdentifier: 'xec-testnet',
            payments: financial.stealthPayments,
          },
        ],
        deliveryOf: async () => 'delivered',
      }),
      onError: failure => {
        throw failure.error
      },
    })
    await recovery.tick()
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.every(batch => batch.length === 1 && batch[0] === raw)).toBe(
      true,
    )
    const recipient = await open(
      { ...root, bytes: new Uint8Array(32).fill(10) },
      new InMemoryEcashOperationStore(),
    )
    const group = groupRecipientAssetPayment(item, {
      payloadDigest: 'cd'.repeat(32),
      spendPublicKey: publicKey,
    }).groups[0]
    expect(
      await recordRecipientAssetPayment(item, {
        payloadDigest: 'cd'.repeat(32),
        spendPublicKey: publicKey,
        assertCurrent: () => undefined,
        openWallet: async () => recipient,
      }),
    ).toEqual([{ index: 0, status: 'recorded' }])
    expect(await recipient.stealthReceipts.observe(group.claim)).toMatchObject({
      status: 'pending',
    })
    mined = true
    expect(await recipient.stealthReceipts.observe(group.claim)).toMatchObject({
      status: 'succeeded',
      verifiedReceivedAmountAtomic: 1000n,
      spendability: 'spendable',
    })
  } finally {
    await messaging.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

/** Node selects the SDK's native WASM loader; Jest resolves its browser ESM loader.
 * Bundle Frank sources from this checkout so shared workspace links cannot redirect owners.
 * The only substituted modules are the same session and wallet-capture boundaries as above. */
const ecashNodeDriver = String.raw`
const fs = require('fs'), path = require('path'), os = require('os');
const tree = process.argv[1], entry = process.argv[2];
const moduleAt = name => require.resolve(name, {paths:[tree+'/node_modules']});
const esbuild = require(moduleAt('esbuild'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'frank-composed-sdk-'));
const output = path.join(temp,'proof.cjs');
const banner = 'const {ModuleMocker}=require('+JSON.stringify(moduleAt('jest-mock'))+');'+
 'const mm=new ModuleMocker(globalThis);'+
 'globalThis.jest={spyOn:mm.spyOn.bind(mm),restoreAllMocks:mm.restoreAllMocks.bind(mm),mock(){},mocked:x=>x};'+
 'globalThis.expect=require('+JSON.stringify(moduleAt('expect'))+').expect;'+
 'const proofTests=[],proofAfter=[];globalThis.test=(name,fn)=>proofTests.push([name,fn]);'+
 'test.each=values=>(name,fn)=>values.forEach(v=>test(name.replace("%s",v),()=>fn(v)));'+
 'globalThis.afterEach=fn=>proofAfter.push(fn);';
const plugin = {name:'checkout-and-composition',setup(build){
 build.onResolve({filter:/^\.\/vite-env$/},()=>({path:tree+'/packages/wallet/chain/vite-env.node.ts'}));
 build.onResolve({filter:/^\.\.\/accounts\/(session|native-transfer)$/},args=>({path:args.path,namespace:'composition'}));
 build.onLoad({filter:/.*/,namespace:'composition'},args=>({loader:'js',contents:args.path.endsWith('session')?
  'export const accountSession={get state(){return globalThis.__composedPaymentBridge.session},getWallet:async()=>globalThis.__composedPaymentBridge.messaging};':
  'export const createNativeTransferContext=async chain=>({captureWallet:async()=>{const wallet=globalThis.__composedPaymentBridge.financial;if(wallet.chainIdentifier!==chain)throw Error("Wrong financial owner");return {wallet,assertCurrent:async()=>{if(wallet!==globalThis.__composedPaymentBridge.financial)throw Error("Owner replaced")}}}});'}));
 build.onResolve({filter:/^@frank\//},args=>{
  const parts=args.path.slice(7).split('/'), name=parts.shift(), sub=parts.join('/');
  const folder=name==='codec'?'frank-codec':name;
  const base=path.join(tree,'packages',folder,['wallet','cashweb'].includes(name)?sub:'src/'+(sub||'index'));
  const found=[base,base+'.ts',base+'.js',base+'/index.ts'].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
  if(!found)throw Error('Unresolved checkout source '+base);return {path:found};
 });
 build.onResolve({filter:/^[^./]/},args=>({path:require.resolve(args.path,{paths:[path.dirname(args.importer),tree+'/node_modules']}),external:true}));
}};
(async()=>{
 try {
  await esbuild.build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:output,
   plugins:[plugin],tsconfig:tree+'/app/tsconfig.json',banner:{js:banner},
   footer:{js:';(async()=>{for(const [name,fn] of proofTests){if(!name.includes("eCash"))continue;try{await fn();console.log("PASS actual eCash app composition")}finally{for(const f of proofAfter)await f()}}})().catch(e=>{console.error(e);process.exitCode=1});'}});
  require(output);
 } finally { fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
`
test.each(['btc-testnet', 'bch-testnet'] as const)(
  'app review → actual %s signed owner → original-byte recovery → recipient dispatch',
  async chainIdentifier => {
    const {
      UtxoWallet,
      UTXO_NETWORKS,
      memoryUtxoWalletStore,
      parseUtxoAddress,
    } = await import('@frank/wallet/utxo-wallet')
    const {
      parseTransaction,
      lockingScript,
      privateKeyFromBytes,
      publicFromPrivate,
      signEcdsa,
    } = await import('@frank/nakamoto')
    const { stealthParentSecret } = await import(
      '@frank/cashweb/relay/stealth-parent'
    )
    const { secp256k1 } = await import('@noble/curves/secp256k1')
    const network = UTXO_NETWORKS[chainIdentifier]
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
    const custody = (
      byte: number,
    ): import('@frank/wallet/utxo-stealth').UtxoStealthCustody => {
      const identitySecret = new Uint8Array(32).fill(byte)
      const identityPublicKey = secp256k1.getPublicKey(identitySecret, true)
      return {
        identityPublicKey,
        assertActive: () => undefined,
        async deriveStealthSigner(derivation) {
          if (
            derivation.chainIdentifier !== chainIdentifier ||
            hex(derivation.identityPublicKey) !== hex(identityPublicKey)
          )
            throw new Error('Wrong custody scope')
          const derive = () =>
            stealthParentSecret(identitySecret, derivation.ephemeralPubKey)
              .secret
          const secret = derive(),
            key = privateKeyFromBytes(secret, true)
          secret.fill(0)
          if (!key.ok) throw new Error('Invalid synthetic custody key')
          const point = publicFromPrivate(key.value)
          key.value.bytes.fill(0)
          if (!point.ok) throw new Error('Invalid synthetic custody point')
          return {
            publicKey: point.value.compressed,
            sign(digest) {
              const secret = derive(),
                key = privateKeyFromBytes(secret, true)
              secret.fill(0)
              if (!key.ok) throw new Error('Invalid synthetic signer')
              try {
                const signature = signEcdsa(key.value, digest)
                if (!signature.ok) throw new Error('Signing failed')
                return signature.value
              } finally {
                key.value.bytes.fill(0)
              }
            },
          }
        },
      }
    }
    const senderCustody = custody(21),
      receiverCustody = custody(55)
    const coins = new Map<
      string,
      import('@frank/wallet/utxo-wallet').IndexedOutput[]
    >()
    const known = new Set<string>(),
      confirmed = new Set<string>(),
      broadcasts: string[] = []
    const indexer: import('@frank/wallet/utxo-wallet').UtxoIndexer = {
      listUnspent: async script => coins.get(hex(script)) ?? [],
      hasHistory: async script => coins.has(hex(script)),
      hasTransaction: async txid => known.has(txid),
      transactionConfirmation: async txid =>
        confirmed.has(txid) ? { height: 100 } : undefined,
      feeRate: async () => 2n,
      broadcast: async raw => {
        broadcasts.push(raw)
      },
    }
    const store = memoryUtxoWalletStore()
    const open = () =>
      UtxoWallet.create({
        network,
        seed: new Uint8Array(32).fill(7),
        indexer,
        storeFor: () => store,
        stealthCustody: senderCustody,
      })
    let sender = await open()
    const receiver = await UtxoWallet.create({
      network,
      seed: new Uint8Array(32).fill(8),
      indexer,
      storeFor: () => memoryUtxoWalletStore(),
      stealthCustody: receiverCustody,
    })
    const sourceScript = lockingScript(
      parseUtxoAddress(network, sender.identity.address.raw)!,
    )
    coins.set(hex(sourceScript), [
      { txid: '11'.repeat(32), vout: 0, amount: 70_000n, height: 100 },
    ])
    const dir = await mkdtemp(join(tmpdir(), 'frank-composed-utxo-message-'))
    const messaging = (await createEvmChain(
      configuration(join(dir, 'message')),
    ).createWallet(roots())) as EvmChainWalletHandle
    node().attach(messaging)
    mockMessagingWallet = messaging
    mockFinancialWallet = sender
    jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
      address: messaging.identity.address,
      pubKey: receiverCustody.identityPublicKey,
    })
    try {
      const review = await reviewStealthPayment({
        request: {
          address: messaging.identity.displayAddress,
          chainIdentifier,
          assetKey: chainIdentifier,
          asset: { kind: 'native' },
          amountAtomic: 10_000n,
          memo: '',
        },
        stampValue: 0n,
        isCurrent: () => true,
      })
      expect(JSON.parse(store.load()!).operations ?? []).toEqual([])
      expect(broadcasts).toEqual([])
      let raw!: string, item!: RecipientAssetPaymentItem, txid!: string
      const digest = 'ef'.repeat(32)
      await sendReviewedStealthPayment(
        review,
        undefined,
        async (prepared, projection) => {
          expect(prepared.members).toHaveLength(1)
          const member = prepared.members[0]
          raw = member.rawTransaction
          txid = member.txHash
          const parsed = parseTransaction(
            Uint8Array.from(Buffer.from(raw, 'hex')),
            network.descriptor,
          )
          if (!parsed.ok) throw new Error('Invalid real signed transaction')
          expect(parsed.value.outputs[member.vout!].value).toBe(10_000n)
          expect(parsed.value.outputs[member.vout!].scriptPubKey).toEqual(
            prepared.recipientDestination,
          )
          expect(
            70_000n -
              parsed.value.outputs.reduce((sum, o) => sum + o.value, 0n),
          ).toBeLessThanOrEqual(review.maxNativeFeeAtomic)
          item = decodeRecipient(projection)
          const outgoing = await captureOutgoingFinancialOperations(messaging, [
            { chainIdentifier, operationId: prepared.operationId },
          ])
          await expect(outgoing.submit()).rejects.toThrow()
          expect(broadcasts).toEqual([])
          // This callback represents the host's completed encrypted-envelope persistence seam.
          await outgoing.expose(digest)
          await outgoing.submit()
        },
      )
      expect(
        await sender.stealthPayments!.release(review.quote.operationId),
      ).toBe(false)
      sender = await open()
      mockFinancialWallet = sender
      expect(
        (await sender.stealthPayments!.get(review.quote.operationId))!
          .members[0].rawTransaction,
      ).toBe(raw)
      const recovery = createFinancialOperationRecovery({
        captureSession: async () => ({
          isCurrent: () => true,
          wallets: [
            {
              owner: sender,
              chainIdentifier,
              payments: sender.stealthPayments!,
            },
          ],
          deliveryOf: async () => 'delivered',
        }),
        onError: failure => {
          throw failure.error
        },
      })
      await recovery.tick()
      expect(broadcasts.length).toBeGreaterThanOrEqual(2)
      expect(broadcasts.every(bytes => bytes === raw)).toBe(true)
      const claim = groupRecipientAssetPayment(item, {
        payloadDigest: digest,
        spendPublicKey: receiverCustody.identityPublicKey,
      }).groups[0].claim
      expect(claim).toMatchObject({
        chainIdentifier,
        asset: { kind: 'native' },
        amountAtomic: 10_000n,
        rawTransactions: [raw],
      })
      expect(
        await recordRecipientAssetPayment(item, {
          payloadDigest: digest,
          spendPublicKey: receiverCustody.identityPublicKey,
          assertCurrent: () => undefined,
          openWallet: async () => receiver,
        }),
      ).toEqual([{ index: 0, status: 'recorded' }])
      expect(await receiver.stealthReceipts!.observe(claim)).toMatchObject({
        status: 'pending',
      })
      known.add(txid)
      confirmed.add(txid)
      const parsed = parseTransaction(
        Uint8Array.from(Buffer.from(raw, 'hex')),
        network.descriptor,
      )
      if (!parsed.ok) throw new Error('Invalid signed bytes')
      coins.set(hex(sourceScript), [])
      parsed.value.outputs.forEach((output, vout) =>
        coins.set(hex(output.scriptPubKey), [
          { txid, vout, amount: output.value, height: 100 },
        ]),
      )
      expect(await receiver.stealthReceipts!.observe(claim)).toMatchObject({
        status: 'succeeded',
        verifiedReceivedAmountAtomic: 10_000n,
        spendability: 'spendable',
      })
    } finally {
      await messaging.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

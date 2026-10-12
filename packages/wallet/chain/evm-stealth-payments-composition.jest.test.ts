import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
/**
 * A contract call through the composed EVM wallet handle: the wallet queue, the main-account
 * coordination, the input admission and the on-disk native journal, as the app reaches it. Only
 * the node is stubbed (the provider's JSON-RPC methods). The same call path against the real
 * network, without this composition, is `swap/swap-real.livecheck.ts`.
 */
import {
  Transaction,
  getBytes,
  Wallet,
  Interface,
  keccak256,
  type Block,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import { createEvmChain } from './monad-chain'
import type { EvmChainConfig } from './evm-chain-config'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { MonadRootBundle } from './active-chain'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import { deriveEvmStealthAddress } from '../monad-stealth'
import { getEvmDexDeployment } from './dex-deployments'
import { LevelRecordStore } from '../storage/evm-coin-store'
import { EvmLegacyConsolidator } from './evm-legacy-consolidator'
import { applyWalletSyncItem } from '../sync-dispatcher'

const config: EvmChainConfig = {
  networkId: 'monad-test',
  chainId: 10143,
  rpcChain: 'monad-testnet',
  relayBaseUrl: 'http://127.0.0.1:1',
  networkTag: 'MONT',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  resolveDefaultStamp: fixedStampDefault(1n),
  defaultTopicVoteValueWei: 1n,
  subAccountPoolSize: 2,
  // The stub node never mines on its own: a native send looks once and returns.
  nativeInclusionWaitMs: 0,
  walletStorageLocation: false,
}
/** The main account the frozen domain-root vector 0 derives (see monad-domain-wallet tests). */
const MAIN = '0x4669EFf913A3c595CeA5FA92a600201e8e9E75d8'
const ROUTER = '0x1b7bFCd2870329B987191910D85c22C7287f3c22'
const CALLDATA = '0x3593564c' + '00'.repeat(32)

function roots(): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: Uint8Array.from(
      Buffer.from(vectors.vectors[0].outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

function stubNode(
  wallet: EvmChainWalletHandle,
  mainBalance: bigint,
  others: Record<string, bigint> = {},
) {
  const balances = new Map([
    [MAIN.toLowerCase(), mainBalance],
    ...Object.entries(others).map(
      ([address, value]) => [address.toLowerCase(), value] as [string, bigint],
    ),
  ])
  const nonces = new Map<string, number>()
  const transactions = new Map<string, TransactionResponse>()
  const receipts = new Map<string, TransactionReceipt>()
  const blockHash = '0x' + 'ab'.repeat(32)
  let lose = false
  const p = wallet.provider
  jest
    .spyOn(p, 'getBlock')
    .mockResolvedValue({ hash: blockHash, number: 1 } as Block)
  jest
    .spyOn(p, 'getBalance')
    .mockImplementation(async a => balances.get(String(a).toLowerCase()) ?? 0n)
  jest
    .spyOn(p, 'getTransactionCount')
    .mockImplementation(async a => nonces.get(String(a).toLowerCase()) ?? 0)
  jest.spyOn(p, 'getFeeData').mockResolvedValue({
    gasPrice: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as never)
  // What a node answers for a plain transfer to an account without code.
  jest.spyOn(p, 'estimateGas').mockResolvedValue(21_000n)
  jest
    .spyOn(p, 'getTransaction')
    .mockImplementation(async hash => transactions.get(hash) ?? null)
  jest
    .spyOn(p, 'getTransactionReceipt')
    .mockImplementation(async hash => receipts.get(hash) ?? null)
  const broadcast = jest
    .spyOn(p, 'broadcastTransaction')
    .mockImplementation(async raw => {
      if (lose) throw new Error('reply lost')
      const tx = Transaction.from(raw)
      const from = tx.from!.toLowerCase()
      nonces.set(from, tx.nonce + 1)
      balances.set(from, (balances.get(from) ?? 0n) - tx.value - tx.gasLimit)
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
        gasUsed: tx.gasLimit,
        logs: [],
      } as TransactionReceipt)
      return { hash: keccak256(raw) } as TransactionResponse
    })
  return {
    broadcast,
    balances,
    receipts,
    transactions,
    loseReplies: (value: boolean) => {
      lose = value
    },
    carryOver: (next: EvmChainWalletHandle) => {
      const again = stubNode(next, balances.get(MAIN.toLowerCase())!)
      return again
    },
  }
}

afterEach(() => jest.restoreAllMocks())

test('production native preparation retains exact bytes and claims until bound exposure and explicit submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-financial-stealth-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  let wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  try {
    let state = stubNode(wallet, 1_000_000n)
    const intent = {
      operationId: 'native-financial-1',
      chainIdentifier: 'monad-testnet',
      asset: { kind: 'native' as const },
      recipientSpendPublicKey: wallet.identity!.compressedPubKey,
      amountAtomic: 1_000n,
      maxNativeFeeAtomic: 100_000n,
      sourceAddress: MAIN,
    }
    const {
      maxNativeFeeAtomic: _ceiling,
      sourceAddress: _source,
      ...unsignedIntent
    } = intent
    const quote = await wallet.stealthPayments!.quote!(unsignedIntent)
    expect(quote).toMatchObject({
      sourceAddress: MAIN.toLowerCase(),
      amountAtomic: 1000n,
      nativeBalanceAtomic: 1000000n,
      assetBalanceAtomic: 1000000n,
      estimatedNativeFeeAtomic: 21000n,
    })
    expect(wallet.getNativeOperations!()).toEqual([])
    expect(
      await wallet.stealthPayments!.get(intent.operationId),
    ).toBeUndefined()
    expect(state.broadcast).not.toHaveBeenCalled()
    await expect(
      wallet.stealthPayments!.expose({
        operationId: intent.operationId,
        payloadDigest: 'aa'.repeat(32),
      }),
    ).rejects.toThrow(/unavailable/)
    await wallet.close()
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    state = stubNode(wallet, 1_000_000n)
    expect(await wallet.stealthPayments!.quote!(unsignedIntent)).toEqual(quote)
    expect(wallet.getNativeOperations!()).toEqual([])
    intent.maxNativeFeeAtomic = quote.estimatedNativeFeeAtomic
    const prepared = await wallet.stealthPayments!.prepare(intent)
    expect(prepared.recipientDestination).toEqual(quote.recipientDestination)
    expect(prepared.ephemeralPublicKey).toEqual(quote.ephemeralPublicKey)

    expect(prepared.recipientSpendPublicKey).toEqual(
      new Uint8Array(intent.recipientSpendPublicKey),
    )
    expect(await wallet.stealthPayments!.list()).toEqual([
      { operationId: intent.operationId },
    ])
    expect(state.broadcast).not.toHaveBeenCalled()
    expect(
      await Promise.all([
        wallet.stealthPayments!.prepare(intent),
        wallet.stealthPayments!.prepare(intent),
      ]),
    ).toEqual([prepared, prepared])
    await expect(
      wallet.stealthPayments!.prepare({ ...intent, amountAtomic: 1_001n }),
    ).rejects.toThrow(/conflict/)
    await expect(
      wallet.stealthPayments!.submit(intent.operationId),
    ).rejects.toThrow(/exposure/)
    await wallet.reobserveNativeOperations!()
    expect(state.broadcast).not.toHaveBeenCalled()
    const beforeReopenFunding = jest.fn()
    await expect(
      wallet.runOwnTransfer!(beforeReopenFunding, { mainAccountWaitMs: 0 }),
    ).rejects.toThrow()
    expect(beforeReopenFunding).not.toHaveBeenCalled()
    await wallet.close()
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    state = stubNode(wallet, 1_000_000n)
    expect(await wallet.stealthPayments!.get(intent.operationId)).toEqual(
      prepared,
    )
    expect(wallet.pool.accountClaimedBy(MAIN)).toBeDefined()
    const sign = jest.fn()
    await expect(
      wallet.runOwnTransfer!(sign, { mainAccountWaitMs: 0 }),
    ).rejects.toThrow()
    expect(sign).not.toHaveBeenCalled()
    const digest = 'cd'.repeat(32)
    await wallet.stealthPayments!.expose({
      operationId: intent.operationId,
      payloadDigest: digest,
    })
    await expect(
      wallet.stealthPayments!.expose({
        operationId: intent.operationId,
        payloadDigest: 'ef'.repeat(32),
      }),
    ).rejects.toThrow(/conflict/)
    expect(await wallet.stealthPayments!.release(intent.operationId)).toBe(
      false,
    )
    expect(state.broadcast).not.toHaveBeenCalled()
    expect(
      await wallet.stealthPayments!.submit(intent.operationId),
    ).toMatchObject({ status: 'pending' })
    expect(
      await wallet.stealthPayments!.reconcile(intent.operationId),
    ).toMatchObject({
      status: 'succeeded',
      intendedAmountAtomic: 1_000n,
      verifiedReceivedAmountAtomic: 1_000n,
    })
    expect(state.broadcast).toHaveBeenCalledWith(
      prepared.members[0]!.rawTransaction,
    )
    const receiptClaim = {
      chainIdentifier: intent.chainIdentifier,
      asset: intent.asset,
      recipientDestination: prepared.recipientDestination,
      ephemeralPublicKey: prepared.ephemeralPublicKey,
      amountAtomic: intent.amountAtomic,
      rawTransactions: prepared.members.map(member => member.rawTransaction),
      payloadDigest: digest,
    }
    const accountNote = {
      type: 'received-coin' as const,
      chainIdentifier: intent.chainIdentifier,
      address: prepared.recipientAddress,
      origin: 'stealth' as const,
      ephemeralPubKey: Buffer.from(prepared.ephemeralPublicKey).toString('hex'),
      claimedAmountWei: '0',
      timestamp: 1,
    }
    await applyWalletSyncItem(wallet, accountNote)
    await wallet.stealthReceipts!.record(receiptClaim)
    await applyWalletSyncItem(wallet, accountNote)
    expect(await wallet.stealthReceipts!.observe(receiptClaim)).toMatchObject({
      status: 'succeeded',
      verifiedReceivedAmountAtomic: 1_000n,
    })
    await expect(
      wallet.stealthReceipts!.record({
        ...receiptClaim,
        recipientDestination: new Uint8Array(19),
      }),
    ).rejects.toThrow(/20 bytes/)
    const canonical = state.receipts.get(prepared.members[0]!.txHash)!
    state.receipts.set(canonical.hash, {
      ...canonical,
      blockHash: '0x' + 'ff'.repeat(32),
    } as TransactionReceipt)
    await expect(wallet.stealthReceipts!.observe(receiptClaim)).rejects.toThrow(
      /inclusion/,
    )
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('production ERC20 receipt retains a gasless account and later signs from that owned source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-financial-erc20-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  let wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  const abi = new Interface([
    'function transfer(address,uint256) returns(bool)',
    'function balanceOf(address) view returns(uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ])
  const token = getEvmDexDeployment('monad-testnet')!.tokens.find(
    item => item.symbol === 'USDC',
  )!.address!
  const chomp = getEvmDexDeployment('monad-testnet')!.tokens.find(
    item => item.symbol === 'CHOMP',
  )!.address!
  const sender = new Wallet('0x' + '07'.repeat(32))
  const amount = 20_000_000n
  const derived = deriveEvmStealthAddress({
    recipientSpendPubKey: wallet.identity!.compressedPubKey,
  })
  const raw = await sender.signTransaction({
    chainId: 10143n,
    type: 2,
    to: token,
    data: abi.encodeFunctionData('transfer', [derived.stealthAddress, amount]),
    value: 0n,
    nonce: 0,
    gasLimit: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
  const claim = {
    chainIdentifier: 'monad-testnet',
    asset: { kind: 'erc20' as const, contractAddress: token },
    recipientDestination: getBytes(derived.stealthAddress),
    ephemeralPublicKey: derived.ephemeralPubKey,
    amountAtomic: amount,
    rawTransactions: [raw],
    payloadDigest: 'ab'.repeat(32),
  }
  const receipt = {
    hash: Transaction.from(raw).hash!,
    from: sender.address,
    to: token,
    status: 1,
    blockHash: '0x' + 'ab'.repeat(32),
    blockNumber: 1,
    index: 0,
    gasUsed: 100_000n,
    gasPrice: 1n,
    logs: [
      {
        address: token,
        ...abi.encodeEventLog(abi.getEvent('Transfer')!, [
          sender.address,
          derived.stealthAddress,
          amount,
        ]),
        index: 2,
      },
    ],
  } as unknown as TransactionReceipt
  const attach = () => {
    const state = stubNode(wallet, 1_000_000n)
    state.receipts.set(receipt.hash, receipt)
    jest.spyOn(wallet.provider, 'call').mockImplementation(async request => {
      const decoded = abi.decodeFunctionData(
        'balanceOf',
        request.data! as string,
      )
      return abi.encodeFunctionResult('balanceOf', [
        String(decoded[0]).toLowerCase() ===
        derived.stealthAddress.toLowerCase()
          ? amount
          : 0n,
      ])
    })
    return state
  }
  try {
    let state = attach()
    await expect(wallet.stealthReceipts!.submit(claim)).rejects.toThrow(
      /durably recorded/,
    )
    expect(state.broadcast).not.toHaveBeenCalled()
    await wallet.stealthReceipts!.record(claim)
    await wallet.stealthReceipts!.record(claim)
    await expect(
      wallet.stealthReceipts!.record({
        ...claim,
        asset: { kind: 'erc20', contractAddress: chomp },
      }),
    ).rejects.toThrow(/differs/)
    expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
      status: 'succeeded',
      verifiedReceivedAmountAtomic: amount,
      spendability: 'needs-native-gas',
    })
    expect(state.broadcast).not.toHaveBeenCalled()
    await expect(
      wallet.stealthReceipts!.submit({
        ...claim,
        payloadDigest: 'cd'.repeat(32),
      }),
    ).rejects.toThrow(/durably recorded/)
    state.broadcast.mockResolvedValueOnce({
      hash: Transaction.from(raw).hash!,
    } as TransactionResponse)
    await wallet.stealthReceipts!.submit(claim)
    expect(state.broadcast).toHaveBeenCalledWith(raw)
    state.broadcast.mockClear()
    const intent = {
      operationId: 'erc20-financial-1',
      chainIdentifier: 'monad-testnet',
      asset: claim.asset,
      recipientSpendPublicKey: Uint8Array.from(
        Buffer.from(sender.signingKey.compressedPublicKey.slice(2), 'hex'),
      ),
      amountAtomic: amount,
      maxNativeFeeAtomic: 100_000n,
      sourceAddress: derived.stealthAddress,
    }
    await expect(wallet.stealthPayments!.prepare(intent)).rejects.toThrow(
      /native funds/,
    )
    expect(state.broadcast).not.toHaveBeenCalled()
    await wallet.close()
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    state = attach()
    expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
      status: 'succeeded',
      spendability: 'needs-native-gas',
    })
    // An external native deposit makes this same account usable; no sender funding is inferred.
    state.balances.set(derived.stealthAddress.toLowerCase(), 1_000_000n)
    const { maxNativeFeeAtomic: _ceiling, ...unsignedTokenIntent } = intent
    const quote = await wallet.stealthPayments!.quote!(unsignedTokenIntent)
    expect(quote).toMatchObject({
      sourceAddress: derived.stealthAddress.toLowerCase(),
      assetBalanceAtomic: amount,
      nativeBalanceAtomic: 1000000n,
      estimatedNativeFeeAtomic: 24150n,
    })
    expect(
      wallet.getNativeOperations!().filter(
        row => row.preparationId === 'stealth-payment:erc20-financial-1',
      ),
    ).toEqual([])
    expect(state.broadcast).not.toHaveBeenCalled()
    const estimatedCall = jest
      .mocked(wallet.provider.estimateGas)
      .mock.calls.at(-1)![0]
    expect(estimatedCall).toMatchObject({
      from: derived.stealthAddress.toLowerCase(),
      to: token.toLowerCase(),
      value: 0n,
    })
    expect(abi.decodeFunctionData('transfer', estimatedCall.data!)[1]).toBe(
      amount,
    )
    const prepared = await wallet.stealthPayments!.prepare(intent)
    expect(prepared.recipientDestination).toEqual(quote.recipientDestination)
    const tx = Transaction.from(prepared.members[0]!.rawTransaction)
    expect(tx.from!.toLowerCase()).toBe(derived.stealthAddress.toLowerCase())
    expect(tx.to!.toLowerCase()).toBe(token.toLowerCase())
    expect(abi.decodeFunctionData('transfer', tx.data)[1]).toBe(amount)
    expect(state.broadcast).not.toHaveBeenCalled()
    await wallet.stealthPayments!.expose({
      operationId: intent.operationId,
      payloadDigest: 'ef'.repeat(32),
    })
    expect(
      await wallet.stealthPayments!.submit(intent.operationId),
    ).toMatchObject({ status: 'pending' })
    const mined = state.receipts.get(tx.hash!)!
    const transferLog = {
      address: token,
      ...abi.encodeEventLog(abi.getEvent('Transfer')!, [
        derived.stealthAddress,
        prepared.recipientAddress,
        amount,
      ]),
      index: 3,
    }
    state.receipts.set(tx.hash!, {
      ...mined,
      logs: [{ ...transferLog, address: chomp }],
    } as unknown as TransactionReceipt)
    expect(
      await wallet.stealthPayments!.reconcile(intent.operationId),
    ).toMatchObject({ status: 'partial', verifiedReceivedAmountAtomic: 0n })
    state.receipts.set(tx.hash!, {
      ...mined,
      logs: [transferLog],
    } as unknown as TransactionReceipt)
    expect(
      await wallet.stealthPayments!.reconcile(intent.operationId),
    ).toMatchObject({
      status: 'succeeded',
      verifiedReceivedAmountAtomic: amount,
    })
    const reverted = await wallet.stealthPayments!.prepare({
      ...intent,
      operationId: 'erc20-reverted',
    })
    await wallet.stealthPayments!.expose({
      operationId: 'erc20-reverted',
      payloadDigest: 'ad'.repeat(32),
    })
    await wallet.stealthPayments!.submit('erc20-reverted')
    const revertedHash = reverted.members[0]!.txHash
    state.receipts.set(revertedHash, {
      ...state.receipts.get(revertedHash)!,
      status: 0,
    } as TransactionReceipt)
    expect(
      await wallet.stealthPayments!.reconcile('erc20-reverted'),
    ).toMatchObject({ status: 'failed', verifiedReceivedAmountAtomic: 0n })
    const releasable = await wallet.stealthPayments!.prepare({
      ...intent,
      operationId: 'erc20-unexposed',
    })
    expect(await wallet.stealthPayments!.release(releasable.operationId)).toBe(
      true,
    )
    expect(
      await wallet.stealthPayments!.get(releasable.operationId),
    ).toBeUndefined()
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a crash after signing before the manifest journal link recovers the original native operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-financial-link-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  let wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  const compare = LevelRecordStore.prototype.compareAndPut
  let interrupt = true
  const fault = jest
    .spyOn(LevelRecordStore.prototype, 'compareAndPut')
    .mockImplementation(async function (key, expected, row) {
      if (
        interrupt &&
        (row as { journalOperationId?: string }).journalOperationId !==
          undefined
      ) {
        interrupt = false
        throw new Error('interrupted manifest link')
      }
      return compare.call(this, key, expected, row)
    })
  try {
    let state = stubNode(wallet, 1_000_000n)
    const intent = {
      operationId: 'interrupted-native',
      chainIdentifier: 'monad-testnet',
      asset: { kind: 'native' as const },
      recipientSpendPublicKey: wallet.identity!.compressedPubKey,
      amountAtomic: 1_000n,
      maxNativeFeeAtomic: 100_000n,
    }
    await expect(wallet.stealthPayments!.prepare(intent)).rejects.toThrow(
      /interrupted/,
    )
    const signed = wallet.getNativeOperations!().find(
      row => row.kind === 'native',
    )!
    expect(signed.preparationId).toBe('stealth-payment:interrupted-native')
    expect(signed.members[0]!.signed).not.toBeNull()
    expect(state.broadcast).not.toHaveBeenCalled()
    await wallet.close()
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    state = stubNode(wallet, 1_000_000n)
    expect(wallet.pool.accountClaimedBy(MAIN)).toBeDefined()
    const again = await wallet.stealthPayments!.prepare(intent)
    expect(again.members[0]!.rawTransaction).toBe(
      signed.members[0]!.signed!.rawTransaction,
    )
    expect(
      wallet.getNativeOperations!().filter(row => row.kind === 'native'),
    ).toHaveLength(1)
    jest
      .spyOn(EvmLegacyConsolidator.prototype, 'releaseUnexposed')
      .mockRejectedValueOnce(new Error('interrupted local cancellation'))
    await expect(
      wallet.stealthPayments!.release(intent.operationId),
    ).rejects.toThrow(/interrupted local/)
    expect(
      wallet.getNativeOperations!().find(
        row => row.operationId === signed.operationId,
      )!.cancelled,
    ).toBe(false)
    await wallet.close()
    wallet = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    state = stubNode(wallet, 1_000_000n)
    expect(
      wallet.getNativeOperations!().find(
        row => row.operationId === signed.operationId,
      )!.cancelled,
    ).toBe(true)
    expect(await wallet.stealthPayments!.list()).toEqual([])
    expect(await wallet.stealthPayments!.release(intent.operationId)).toBe(true)
    expect(state.broadcast).not.toHaveBeenCalled()
    const signature = jest.fn(async () => ({
      txHash: '0x' + '11'.repeat(32),
      from: MAIN,
      nonce: 0,
    }))
    await wallet.runOwnTransfer!(signature, { mainAccountWaitMs: 0 })
    expect(signature).toHaveBeenCalledTimes(1)
  } finally {
    fault.mockRestore()
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
/**
 * A contract call through the composed EVM wallet handle: the wallet queue, the main-account
 * coordination, the input admission and the on-disk native journal, as the app reaches it. Only
 * the node is stubbed (the provider's JSON-RPC methods). The same call path against the real
 * network, without this composition, is `swap/swap-real.livecheck.ts`.
 */
import {
  Transaction,
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
import { EvmLegacyConsolidator, swapRecordId } from './evm-legacy-consolidator'

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
      } as TransactionReceipt)
      return { hash: keccak256(raw) } as TransactionResponse
    })
  return {
    broadcast,
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

test('the wallet handle sends a contract call from its main account and reports its funds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const wallet = (await createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    const node = stubNode(wallet, 1_000_000n)
    expect((await wallet.getReceiveAddress()).raw).toBe(MAIN)
    expect(await wallet.getContractCallFunds!()).toEqual({
      mainAddress: MAIN.toLowerCase(),
      mainBalance: 1_000_000n,
      otherBalance: 0n,
      mainBusy: false,
    })
    const order: string[] = []
    const sent = await wallet.sendContractCall!({
      to: { raw: ROUTER },
      data: CALLDATA,
      value: 5_000n,
      gasLimit: 250_000n,
      onSigned: async signed => {
        order.push(`signed ${signed.operationId}`)
        expect(node.broadcast).not.toHaveBeenCalled()
        const row = wallet.getNativeOperations!().find(
          r => r.operationId === signed.operationId,
        )!
        expect(row.kind).toBe('contract')
        expect(row.members[0]!.signed!.transactionHash).toBe(signed.txHash)
      },
    })
    expect(order).toEqual([`signed ${sent.operationId}`])
    const raw = node.broadcast.mock.calls[0]![0] as string
    const tx = Transaction.from(raw)
    expect(tx.hash).toBe(sent.txHash)
    expect(tx.from).toBe(MAIN)
    expect(tx.to).toBe(ROUTER)
    expect(tx.data).toBe(CALLDATA)
    expect(tx.value).toBe(5_000n)
    expect(tx.gasLimit).toBe(250_000n)
    expect(tx.chainId).toBe(10143n)
    // A contract call is not a native transfer awaiting resolution in the Send page's sense.
    expect(wallet.getUnresolvedNativeTransaction!()).toBeUndefined()
    expect(wallet.evmReader).toBe(wallet.provider)
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a contract call whose broadcast reply was lost is resent byte for byte after the wallet reopens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  const first = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  let second: EvmChainWalletHandle | undefined
  try {
    const node = stubNode(first, 1_000_000n)
    node.loseReplies(true)
    const failure = await first.sendContractCall!({
      to: { raw: ROUTER },
      data: CALLDATA,
      value: 5_000n,
      gasLimit: 250_000n,
    }).catch(error => error)
    const operationId = failure.operation.operationId as string
    const signed = first.getNativeOperations!().find(
      r => r.operationId === operationId,
    )!.members[0]!.signed!
    expect(failure.transaction.txHash).toBe(signed.transactionHash)
    // Unknown outcome: the account must not build another transaction over it.
    expect((await first.getContractCallFunds!()).mainBusy).toBe(true)
    await expect(
      first.sendContractCall!({
        to: { raw: ROUTER },
        data: CALLDATA,
        value: 5_000n,
        gasLimit: 250_000n,
      }),
    ).rejects.toThrow(/Insufficient unreserved native funds/)
    await first.close()

    second = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    const again = node.carryOver(second)
    await second.resumeNativeOperation!(operationId)
    expect(again.broadcast).toHaveBeenCalledTimes(1)
    expect(again.broadcast).toHaveBeenCalledWith(signed.rawTransaction)
    expect(
      second.getNativeOperations!().filter(r => r.kind === 'contract'),
    ).toHaveLength(1)
  } finally {
    await second?.close()
    await first.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the background poll re-sends a lost contract call, and once it lands the main account sends natively again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const wallet = (await createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    const node = stubNode(wallet, 1_000_000n)
    node.loseReplies(true)
    const failure = await wallet.sendContractCall!({
      to: { raw: ROUTER },
      data: CALLDATA,
      value: 0n,
      gasLimit: 100_000n,
    }).catch(error => error)
    const lost = wallet.getUnresolvedContractCalls!()
    expect(lost).toEqual([
      {
        operationId: failure.operation.operationId,
        txHash: failure.transaction.txHash,
      },
    ])
    await expect(
      wallet.sendNative({ recipient: { raw: ROUTER }, value: 1n }),
    ).rejects.toThrow()

    // The poll every host already runs: no user action, no new signature.
    node.loseReplies(false)
    node.broadcast.mockClear()
    await wallet.reobserveNativeOperations!()
    expect(node.broadcast).toHaveBeenCalledTimes(1)
    const raw = wallet.getNativeOperations!().find(
      r => r.operationId === lost[0]!.operationId,
    )!.members[0]!.signed!.rawTransaction
    expect(node.broadcast).toHaveBeenCalledWith(raw)

    expect((await wallet.getContractCallFunds!()).mainBusy).toBe(false)
    expect(wallet.getUnresolvedContractCalls!()).toEqual([])
    const sent = await wallet.sendNative({
      recipient: { raw: ROUTER },
      value: 1n,
    })
    expect(
      Transaction.from(node.broadcast.mock.calls[1]![0] as string),
    ).toMatchObject({
      hash: sent.txHash,
      from: MAIN,
      nonce: 1,
    })
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a native send whose nonce was consumed by another transaction has failed for good: the main account sends again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const wallet = (await createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }).createWallet(roots())) as EvmChainWalletHandle
  try {
    const node = stubNode(wallet, 1_000_000n)
    // The transfer is signed and handed over, and never reaches the node.
    node.loseReplies(true)
    await expect(
      wallet.sendNative({ recipient: { raw: ROUTER }, value: 1n }),
    ).rejects.toThrow(/outcome is unknown/)
    expect(wallet.getUnresolvedNativeTransaction!()).toBeDefined()
    expect((await wallet.getContractCallFunds!()).mainBusy).toBe(true)
    // Another transaction of this account (signed elsewhere with the same key) takes nonce 0.
    jest.spyOn(wallet.provider, 'getTransactionCount').mockResolvedValue(1)
    node.loseReplies(false)
    node.broadcast.mockClear()
    // One look shows it: the node knows neither the transfer nor a receipt, and the nonce is
    // gone. Nothing is left to resolve, and the account is free.
    expect((await wallet.getContractCallFunds!()).mainBusy).toBe(false)
    expect(wallet.getUnresolvedNativeTransaction!()).toBeUndefined()
    const sent = await wallet.sendNative({
      recipient: { raw: ROUTER },
      value: 1n,
    })
    expect(
      Transaction.from(node.broadcast.mock.calls[0]![0] as string),
    ).toMatchObject({ hash: sent.txHash, from: MAIN, nonce: 1 })
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Notes are started, not waited for: resolves once every note started so far has settled. */
function watchNotes() {
  const started = jest.spyOn(EvmLegacyConsolidator.prototype, 'startSync')
  return async () => {
    for (const result of started.mock.results)
      await Promise.resolve(result.value as unknown).catch(() => undefined)
    for (const owner of new Set(started.mock.contexts)) await owner.drain()
  }
}

const SWAP_RECORD = {
  kind: 'swap' as const,
  venueId: 'uniswap-v4',
  account: MAIN,
  assetIn: { symbol: 'MON', address: null, decimals: 18 },
  amountIn: '5000',
  assetOut: {
    symbol: 'USDC',
    address: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    decimals: 6,
  },
  quotedAmountOut: '4997',
  minimumAmountOut: '4947',
  interfaceFeeAmount: '0',
  networkFeeWei: '250000',
  route: { zeroForOne: true },
}

test('a swap is recorded by the wallet: journaled with the call before signing, then carried by its free note to self', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const cfg = {
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  const chain = createEvmChain(cfg)
  const notesSettled = watchNotes()
  const transport = jest
    .spyOn(chain.directMessages, 'send')
    .mockResolvedValue({} as never)
  const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  let reopened: EvmChainWalletHandle | undefined
  try {
    const node = stubNode(wallet, 1_000_000n)
    const sent = await wallet.sendContractCall!({
      to: { raw: ROUTER },
      data: CALLDATA,
      value: 5_000n,
      gasLimit: 250_000n,
      record: SWAP_RECORD,
      onSigned: async signed => {
        // In the wallet's own journal, with the signed bytes, before anything is broadcast.
        expect(node.broadcast).not.toHaveBeenCalled()
        expect(
          wallet.getNativeOperations!().find(
            r => r.operationId === signed.operationId,
          )!.record,
        ).toEqual(SWAP_RECORD)
      },
    })
    // Not yet seen in a block by the wallet: no note yet.
    await notesSettled()
    expect(transport).not.toHaveBeenCalled()

    // The swap flow asks the wallet to take the inclusion in; the wallet starts its note.
    await wallet.resumeNativeOperation!(sent.operationId)
    await notesSettled()
    expect(node.broadcast).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const [note] = transport.mock.calls[0]!
    expect(note.stampValue).toBe(0n)
    expect(note.recipient.raw.toLowerCase()).toBe(
      wallet.identity.address.raw.toLowerCase(),
    )
    expect(note.items).toEqual([
      expect.objectContaining({ type: 'wallet-sync', txHash: sent.txHash }),
      {
        type: 'swap-record',
        swapId: swapRecordId('monad-testnet', sent.txHash),
        chainIdentifier: 'monad-testnet',
        venueId: 'uniswap-v4',
        txHash: sent.txHash,
        account: MAIN,
        assetIn: { symbol: 'MON', decimals: 18 },
        amountIn: '5000',
        assetOut: {
          symbol: 'USDC',
          address: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
          decimals: 6,
        },
        quotedAmountOut: '4997',
        minimumAmountOut: '4947',
        interfaceFee: '0',
        networkFee: '250000',
        route: '{"zeroForOne":true}',
        timestamp: expect.any(Number),
      },
    ])
    // The id is derived from the exact string it is given (a Solana signature is
    // case-sensitive); an EVM hash is put in lower case by the caller, as here.
    expect(sent.txHash).toBe(sent.txHash.toLowerCase())
    expect(swapRecordId('monad-testnet', sent.txHash.toUpperCase())).not.toBe(
      swapRecordId('monad-testnet', sent.txHash),
    )
    expect(swapRecordId('monad-mainnet', sent.txHash)).not.toBe(
      swapRecordId('monad-testnet', sent.txHash),
    )
    expect(wallet.getNativeOperations!()[0]!.members[0]!.syncApplied).toBe(true)

    // The record is the wallet's: it is still there after the wallet is closed and reopened.
    await wallet.close()
    reopened = (await createEvmChain(cfg).createWallet(
      roots(),
    )) as EvmChainWalletHandle
    expect(reopened.getNativeOperations!()[0]!.record).toEqual(SWAP_RECORD)
  } finally {
    await reopened?.close()
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a note that cannot be sent leaves the swap as it was and is owed, not repeated as a swap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const chain = createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const notesSettled = watchNotes()
  const transport = jest
    .spyOn(chain.directMessages, 'send')
    .mockRejectedValueOnce(new Error('relay unreachable'))
    .mockResolvedValue({} as never)
  const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  try {
    const node = stubNode(wallet, 1_000_000n)
    const sent = await wallet.sendContractCall!({
      to: { raw: ROUTER },
      data: CALLDATA,
      value: 5_000n,
      gasLimit: 250_000n,
      record: SWAP_RECORD,
    })
    await wallet.resumeNativeOperation!(sent.operationId)
    await notesSettled()
    expect(transport).toHaveBeenCalledTimes(1)
    const member = () => wallet.getNativeOperations!()[0]!.members[0]!
    expect(member().observation.state).toBe('included-success')
    expect(member().syncApplied).toBe(false)
    // The wallet's own retry sends the note again; the swap is never broadcast again.
    await wallet.resumeNativeOperation!(sent.operationId)
    await notesSettled()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(member().syncApplied).toBe(true)
    expect(node.broadcast).toHaveBeenCalledTimes(1)
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the move into the main account notes itself like any legacy send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frank-contract-composition-'))
  const chain = createEvmChain({
    ...config,
    walletStorageLocation: join(dir, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  })
  const notesSettled = watchNotes()
  const transport = jest
    .spyOn(chain.directMessages, 'send')
    .mockResolvedValue({} as never)
  const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
  try {
    const identity = wallet.identity.address.raw
    stubNode(wallet, 0n, { [identity]: 1_000_000n })
    const moved = await wallet.fundMainAccount!({ value: 400_000n })
    await notesSettled()
    expect(transport).toHaveBeenCalledTimes(1)
    const [note] = transport.mock.calls[0]!
    expect(note.stampValue).toBe(0n)
    expect(note.recipient.raw.toLowerCase()).toBe(identity.toLowerCase())
    // An ordinary transfer: its transaction, and no swap record.
    expect(note.items).toEqual([
      expect.objectContaining({
        type: 'wallet-sync',
        txHash: moved.txHash,
        createdOutputs: [expect.objectContaining({ valueWei: '400000' })],
      }),
    ])
    expect((await wallet.getContractCallFunds!()).mainBalance).toBe(400_000n)
  } finally {
    await wallet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

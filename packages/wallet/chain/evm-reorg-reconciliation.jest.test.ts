import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'
import { Transaction, Wallet, type Provider } from 'ethers'
import {
  encodeForumPost,
  encodeTopicPostSubmission,
  encodeForumReadFrame,
  topicBurnCommitment,
  type Encodable,
} from '@frank/codec'

import {
  EVM_FINALITY_CONFIRMATIONS,
  getConfirmationCount,
  isFinalizedAtHead,
  reconcileEvmChainHead,
  type EvmReorgWarning,
} from './evm-reorg-reconciliation'
import { EvmLegacyConsolidator } from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadAccountTxSigner, MonadTxSubmitter } from '../monad-account-tx'
import { InMemorySubAccountPoolStore } from '../storage/sub-account-pool-storage'
import { InMemoryTopicOperationJournal } from '../storage/topic-operation-journal'
import { submitForumOperation } from '../monad-forum-operation'
import type { EvmWalletHandle } from '../evm-wallet-handle'

jest.mock('axios')
const mockedAxios = axios as unknown as jest.Mock

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const CHAIN_ID = 10143n
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'

function blockHashFor(branch: string, height: number): string {
  const hex = Buffer.from(`${branch}:${height}`, 'utf8')
    .toString('hex')
    .padEnd(64, '0')
    .slice(0, 64)
  return `0x${hex}`
}

describe('Head-driven reorg reconciliation and 10-block finality', () => {
  afterEach(() => {
    mockedAxios.mockReset()
  })

  it('enforces a 10-block confirmation threshold for normal finality and skips re-querying finalized blocks on normal head extension', async () => {
    expect(EVM_FINALITY_CONFIRMATIONS).toBe(10)
    expect(getConfirmationCount(10, 18)).toBe(9)
    expect(isFinalizedAtHead(10, 18)).toBe(false)
    expect(getConfirmationCount(10, 19)).toBe(10)
    expect(isFinalizedAtHead(10, 19)).toBe(true)

    let currentHead = 19
    const getBlock = jest.fn(async (tag: string | number) => {
      const n = tag === 'latest' ? currentHead : Number(tag)
      return { number: n, hash: blockHashFor('canon', n) }
    })
    const provider = { getBlock } as unknown as Provider

    const finalizedOp = {
      operationId: 'op-finalized',
      cancelled: false,
      members: [
        {
          source: { kind: 'main' as const, address: '0x' + '11'.repeat(20) },
          observation: {
            state: 'included-success' as const,
            transactionHash: '0x' + 'aa'.repeat(32),
            blockNumber: 10,
            blockHash: blockHashFor('canon', 10),
            transactionIndex: 0,
            feeWei: '21000',
          },
        },
      ],
    } as any

    // Normal head extension from 19 -> 20: block 10 already has 10+ confirmations, so block 10 is not re-queried.
    currentHead = 20
    const res = await reconcileEvmChainHead({
      provider,
      nativeOperations: [finalizedOp],
      previousHead: {
        blockNumber: 19,
        blockHash: blockHashFor('canon', 19),
      },
    })

    expect(res.reorgDetected).toBe(false)
    expect(res.warnings).toHaveLength(0)
    const queriedHeights = getBlock.mock.calls.map(([arg]) => arg)
    expect(queriedHeights).toContain('latest')
    expect(queriedHeights).toContain(19)
    expect(queriedHeights).not.toContain(10)
  })

  it('detects >10-block deep reorgs, rechecks retained native operations, downgrades contradicted inclusions while preserving reservations, and emits explicit warnings', async () => {
    const location = mkdtempSync(join(tmpdir(), 'reorg-native-'))
    try {
      const mainWallet = new Wallet('0x' + '21'.repeat(32))
      const recipient = new Wallet('0x' + '22'.repeat(32))
      const binding = {
        chainIdentifier: 'monad-testnet',
        nativeChainId: String(CHAIN_ID),
        publicTuple: JSON.stringify({
          mainAddress: mainWallet.address.toLowerCase(),
        }),
      }
      const journal = new EvmNativeOperationJournal({ location, binding })
      await journal.Open()

      let activeBranch = 'branchA'
      let headNumber = 25
      let txIncludedOnCurrentBranch = true
      const knownTxs = new Map<string, Transaction>()

      const provider = {
        getBlock: jest.fn(async (tag: string | number) => {
          const n = tag === 'latest' ? headNumber : Number(tag)
          if (n > headNumber) return null
          // Common ancestor at block 10; blocks > 10 depend on activeBranch
          const branch = n <= 10 ? 'common' : activeBranch
          return { number: n, hash: blockHashFor(branch, n) }
        }),
        getBalance: jest.fn(async () => 1_000_000n),
        getTransactionCount: jest.fn(async () =>
          txIncludedOnCurrentBranch ? 1 : 0,
        ),
        getFeeData: jest.fn(async () => ({
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        })),
        estimateGas: jest.fn(async () => 21_000n),
        getTransaction: jest.fn(async (hash: string) => {
          const tx = knownTxs.get(hash.toLowerCase())
          if (!tx) return null
          if (!txIncludedOnCurrentBranch) {
            return Object.assign(Transaction.from(tx.serialized), {
              blockHash: null,
              blockNumber: null,
              index: null,
            })
          }
          return Object.assign(Transaction.from(tx.serialized), {
            blockHash: blockHashFor(activeBranch, 12),
            blockNumber: 12,
            index: 0,
          })
        }),
        getTransactionReceipt: jest.fn(async (hash: string) => {
          const tx = knownTxs.get(hash.toLowerCase())
          if (!tx || !txIncludedOnCurrentBranch) return null
          return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            blockHash: blockHashFor(activeBranch, 12),
            blockNumber: 12,
            index: 0,
            status: 1,
            gasUsed: 21_000n,
            gasPrice: 1n,
          }
        }),
        broadcastTransaction: jest.fn(async (raw: string) => {
          const tx = Transaction.from(raw)
          knownTxs.set(tx.hash!.toLowerCase(), tx)
          return { hash: tx.hash }
        }),
      } as unknown as Provider

      const source = {
        kind: 'main' as const,
        address: mainWallet.address.toLowerCase(),
      }
      const consolidator = new EvmLegacyConsolidator({
        journal,
        provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        getSources: async () => [source],
        sign: async (_src, unsigned) =>
          mainWallet.signTransaction(Transaction.from(unsigned)),
      })

      await consolidator.sendNative({
        recipient: { raw: recipient.address },
        value: 1_000n,
      })
      const opId = journal.list()[0]!.operationId
      await consolidator.observe(opId, 0)
      expect(journal.get(opId).members[0]?.observation.state).toBe(
        'included-success',
      )

      const knownBlocks = new Map<number, string>()
      for (let h = 8; h <= 25; h++) {
        knownBlocks.set(h, blockHashFor(h <= 10 ? 'common' : 'branchA', h))
      }

      // Trigger a 15-block deep reorg back to block 10 on branchB where the tx is back in mempool (pending)
      activeBranch = 'branchB'
      headNumber = 24
      txIncludedOnCurrentBranch = false

      const warnings: EvmReorgWarning[] = []
      const result = await reconcileEvmChainHead({
        provider,
        nativeOperations: journal.list(),
        observeNativeMember: (id, idx) => consolidator.observe(id, idx),
        previousHead: {
          blockNumber: 25,
          blockHash: blockHashFor('branchA', 25),
        },
        knownBlockHashes: knownBlocks,
        onWarning: w => warnings.push(w),
      })

      expect(result.reorgDetected).toBe(true)
      expect(result.commonAncestorBlockNumber).toBe(10)
      expect(result.reorgDepth).toBe(15)
      expect(result.reobservedNativeMembers).toEqual([
        { operationId: opId, memberIndex: 0 },
      ])

      // Member downgraded from `included-success` back to `pending`, observationGeneration incremented, and still holds source!
      const updatedMember = journal.get(opId).members[0]!
      expect(updatedMember.observation.state).toBe('pending')
      expect(updatedMember.observationGeneration).toBeGreaterThanOrEqual(2)
      expect(consolidator.holdsSource(mainWallet.address)).toBe(true)

      expect(warnings.some(w => w.kind === 'deep-reorg')).toBe(true)
      expect(
        warnings.find(w => w.kind === 'native-inclusion-contradicted'),
      ).toMatchObject({
        orphanedBlockNumber: 12,
        orphanedBlockHash: blockHashFor('branchA', 12),
        canonicalBlockHash: blockHashFor('branchB', 12),
      })

      await journal.Close()
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  })

  it('retains spent/funding history with compaction disabled, downgrades disconnected funding on available accounts, and warns on contradicted spend or unspent balance on terminal accounts', async () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const poolStore = new InMemorySubAccountPoolStore()
    const pool = new MonadSubAccountPool({
      keyring,
      store: poolStore,
      expectedChainId: CHAIN_ID,
    })
    const leaseManager = new SubAccountLeaseManager(pool)
    const topicJournal = new InMemoryTopicOperationJournal()

    let activeBranch = 'branchA'
    let headNumber = 15
    const balances = new Map<string, bigint>()
    const nonces = new Map<string, number>()
    const txs = new Map<string, Transaction>()
    const receipts = new Map<string, any>()

    const provider = {
      getNetwork: async () => ({ chainId: CHAIN_ID }),
      getBlock: async (tag: string | number) => {
        const n = tag === 'latest' ? headNumber : Number(tag)
        const branch = n <= 5 ? 'common' : activeBranch
        return { number: n, hash: blockHashFor(branch, n) }
      },
      getBalance: async (addr: string) =>
        balances.get(addr.toLowerCase()) ?? 0n,
      getTransactionCount: async (addr: string) =>
        nonces.get(addr.toLowerCase()) ?? 0,
      getFeeData: async () => ({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        gasPrice: 1n,
      }),
      estimateGas: async () => 21_000n,
      getTransaction: async (hash: string) => {
        const tx = txs.get(hash.toLowerCase())
        if (!tx) return null
        const rcpt = receipts.get(hash.toLowerCase())
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          nonce: tx.nonce,
          data: tx.data,
          chainId: tx.chainId,
          type: tx.type,
          gasLimit: tx.gasLimit,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          accessList: tx.accessList,
          blockNumber: rcpt?.blockNumber ?? null,
          blockHash: rcpt?.blockHash ?? null,
          index: 0,
        }
      },
      getTransactionReceipt: async (hash: string) =>
        receipts.get(hash.toLowerCase()) ?? null,
    } as unknown as Provider

    const httpClient: MonadTxSubmitter = {
      submitRawTransaction: async rawTx => {
        const parsed = Transaction.from(rawTx)
        const hash = parsed.hash!.toLowerCase()
        const from = parsed.from!.toLowerCase()
        const to = parsed.to!.toLowerCase()
        txs.set(hash, parsed)
        nonces.set(from, (nonces.get(from) ?? 0) + 1)
        const gasCost = parsed.gasLimit * (parsed.maxFeePerGas ?? 1n)
        balances.set(
          from,
          (balances.get(from) ?? 0n) - parsed.value - gasCost,
        )
        balances.set(to, (balances.get(to) ?? 0n) + parsed.value)
        receipts.set(hash, {
          txHash: parsed.hash!,
          hash,
          from: parsed.from,
          to: parsed.to,
          status: 1,
          blockNumber: 12,
          blockHash: blockHashFor(activeBranch, 12),
          index: 0,
          gasUsed: parsed.gasLimit,
          gasPrice: 1n,
          effectiveGasPrice: 1n,
          logs: [],
        })
        return parsed.hash!
      },
      getTransactionReceipt: async txHash => {
        const r = receipts.get(txHash.toLowerCase())
        if (!r) return undefined
        return {
          ...r,
          status: r.status === 1 ? ('success' as const) : ('failure' as const),
        }
      },
    }

    const mainWallet = new Wallet('0x' + '41'.repeat(32))
    balances.set(mainWallet.address.toLowerCase(), 10_000_000n)
    const mainSigner = new MonadAccountTxSigner({
      privateKey: mainWallet.privateKey,
      provider,
      httpClient,
    })

    // 1. Prepare and settle sub-account 0 via Forum operation; verify compaction is disabled (retained in pool.records()).
    const compactSpy = jest.fn(async () => 0)
    const walletState = {
      pool,
      leaseManager,
      topicOperationJournal: topicJournal,
      runOperation: async (op: (adm: any) => Promise<unknown>) =>
        op('admission-token'),
      compactTerminalAccounts: compactSpy,
    } as any

    const prep0 = await pool.prepareBurnAccount({
      mainAccountSigner: mainSigner,
      provider,
      burnValueWei: 1_000n,
      gasReserveWei: 100_000n,
      fundingOverrides: {
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: CHAIN_ID,
      },
      receipt: { maxAttempts: 1, intervalMs: 1 },
      claimFor: 'wallet:topic:reorg-0',
      retainPreparationHold: true,
    })

    const postFrame = encodeForumPost({
      network: 'monad-testnet',
      topic: 'general',
      entries: [{ kind: 'post', message: 'retained history check' }],
      authored: { seconds: 1_700_000_000n, nanoseconds: 0 },
    })
    const targetHash = topicBurnCommitment(postFrame).hash

    mockedAxios.mockImplementation(async (config: any) => {
      const reqBytes = new Uint8Array(config.data)
      const op = topicJournal.getAll()[0]!
      await httpClient.submitRawTransaction(op.rawTx)
      const parsedBurn = Transaction.from(op.rawTx)
      const statusBytes = encodeForumReadFrame(
        46,
        new Map<number, Encodable>([
          [0, 'monad-testnet'],
          [1, reqBytes],
          [2, targetHash],
          [3, Uint8Array.from(Buffer.from(op.txHash.slice(2), 'hex'))],
          [4, Uint8Array.from(Buffer.from(op.senderAddress.slice(2), 'hex'))],
          [5, Buffer.from(parsedBurn.data.slice(2), 'hex')[5]!],
          [6, BigInt(op.valueWei)],
          [7, 2],
          [8, 12],
          [9, 0],
          [10, 1],
          [11, new Uint8Array(16).fill(1)],
        ]),
      )
      return {
        data: statusBytes,
        headers: { 'content-type': 'application/cbor' },
      }
    })

    const walletHandle: EvmWalletHandle = {
      pool,
      leaseManager,
      topicOperationJournal: topicJournal,
      walletState,
      provider,
      httpClient,
      relayBaseUrl: 'http://localhost:9999',
      cborNetwork: 'monad-testnet',
      forumBurnAddress: BURN_ADDRESS,
      forumChainId: CHAIN_ID,
    } as any

    await submitForumOperation(walletHandle, {
      kind: 'post',
      target: targetHash,
      direction: 'up',
      burnAddress: BURN_ADDRESS,
      value: 1_000n,
      overrides: {
        gasLimit: 50_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: CHAIN_ID,
      },
      leaseIndex: prep0.index,
      leaseHolder: 'wallet:topic:reorg-0',
      encode: rawTx => encodeTopicPostSubmission(postFrame, rawTx),
    })

    // Compaction is disabled: compactTerminalAccounts was NOT called, and sub-account 0 remains in pool.records()!
    expect(compactSpy).not.toHaveBeenCalled()
    expect(pool.getRecord(prep0.index)?.status).toBe('spent')
    expect(pool.terminalCheckpoints()).toHaveLength(0)

    // 2. Also fund sub-account 1 as `available` at block 12 on branchA.
    await pool.prepareBurnAccount({
      mainAccountSigner: mainSigner,
      provider,
      burnValueWei: 1_000n,
      gasReserveWei: 50_000n,
      fundingOverrides: {
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: CHAIN_ID,
      },
      receipt: { maxAttempts: 1, intervalMs: 1 },
    })
    expect(pool.getRecord(1)?.status).toBe('available')

    // 3. Simulate a deep reorg onto branchB where:
    // - block 12 hash changed (disconnecting sub-account 1's funding),
    // - sub-account 0's spend receipt disappeared and sub-account 0 has an unspent balance of 51,000 wei.
    activeBranch = 'branchB'
    headNumber = 18
    const spendHash0 = pool
      .getRecord(prep0.index)!
      .lifecycle!.spend!.txHash.toLowerCase()
    receipts.delete(spendHash0)

    const result = await reconcileEvmChainHead({
      provider,
      pool,
      previousHead: {
        blockNumber: 15,
        blockHash: blockHashFor('branchA', 15),
      },
    })

    expect(result.reorgDetected).toBe(true)
    // Sub-account 1 downgraded from `available` to `funding` and excluded from lease selection!
    expect(result.downgradedFundingIndices).toContain(1)
    expect(pool.getRecord(1)?.status).toBe('funding')
    expect(
      pool.getRecord(1)?.funding?.attempts[0]?.observation.kind,
    ).toBe('unresolved')
    await expect(leaseManager.acquireLease()).rejects.toThrow()

    // Sub-account 0 remains `spent` (quarantined) and surfaces explicit warnings for disconnected spend & funding.
    expect(pool.getRecord(prep0.index)?.status).toBe('spent')
    expect(
      result.warnings.some(
        w => w.kind === 'funding-disconnected' && w.poolIndex === 1,
      ),
    ).toBe(true)
    expect(
      result.warnings.some(
        w => w.kind === 'spend-contradicted' && w.poolIndex === prep0.index,
      ),
    ).toBe(true)
  })
})

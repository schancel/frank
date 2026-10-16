import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'
import { Transaction, Wallet } from 'ethers'
import level from 'level'

jest.mock('axios')
const mockedAxios = axios as unknown as jest.Mock
import {
  encodeForumPost,
  encodeTopicPostSubmission,
  encodeForumReadFrame,
  topicBurnCommitment,
  type Encodable,
} from '@frank/codec'

import { MonadHdKeyring } from './evm-hd-keyring'
import { MonadSubAccountPool } from './evm-account-pool'
import { SubAccountLeaseManager } from './evm-account-lease'
import {
  MonadAccountTxSigner,
  MonadTxSubmitter,
} from './evm-account-tx'
import {
  LevelSubAccountPoolStore,
  InMemorySubAccountPoolStore,
} from './storage/sub-account-pool-storage'
import {
  InMemoryTopicOperationJournal,
  LevelTopicOperationJournal,
} from './storage/topic-operation-journal'
import { openExistingPoolMonadTopicOwner } from './storage/evm-wallet-bundle'
import { MonadChangeKeyring } from './evm-change-keyring'
import { MonadChangePool } from './evm-change-pool'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'
import {
  reconcileForumOperations,
  submitForumOperation,
} from './evm-forum-operation'
import { TopicBurnPreparationError } from './chain/evm-chain'
import type { EvmWalletHandle } from './evm-wallet-handle'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const CHAIN_ID = 10143n
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'

function makeHarness() {
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const receipts = new Map<
    string,
    {
      txHash: string
      blockNumber: number
      blockHash: string
      status: 'success' | 'failure'
      gasUsed: bigint
      effectiveGasPrice: bigint
      logs: never[]
    }
  >()
  const submittedTxs = new Map<string, Transaction>()
  const blockHash = '0x' + '11'.repeat(32)

  const httpClient: jest.Mocked<MonadTxSubmitter> = {
    submitRawTransaction: jest.fn(async (rawTx: string) => {
      const tx = Transaction.from(rawTx)
      const hash = tx.hash!
      submittedTxs.set(hash.toLowerCase(), tx)
      const from = tx.from!.toLowerCase()
      const to = tx.to!.toLowerCase()
      const fee = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 1n)
      balances.set(from, (balances.get(from) ?? 0n) - tx.value - fee)
      balances.set(to, (balances.get(to) ?? 0n) + tx.value)
      nonces.set(from, Math.max(nonces.get(from) ?? 0, tx.nonce + 1))
      receipts.set(hash.toLowerCase(), {
        txHash: hash,
        blockNumber: 10,
        blockHash,
        status: 'success',
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      })
      return hash
    }),
    getTransactionReceipt: jest.fn(async (txHash: string) => {
      return receipts.get(txHash.toLowerCase())
    }),
  }

  const provider = {
    getBalance: jest.fn(async (address: string) => {
      return balances.get(address.toLowerCase()) ?? 0n
    }),
    getTransactionCount: jest.fn(async (address: string) => {
      return nonces.get(address.toLowerCase()) ?? 0
    }),
    getBlock: jest.fn(async (tag: unknown) => {
      if (tag === 10 || tag === '0x' + (10).toString(16) || tag === blockHash) {
        return { number: 10, hash: blockHash }
      }
      if (tag === 'latest') {
        return { number: 10, hash: blockHash }
      }
      return { number: Number(tag) || 10, hash: blockHash }
    }),
    getNetwork: jest.fn(async () => ({ chainId: CHAIN_ID })),
    estimateGas: jest.fn(async () => 21_000n),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 1n,
    })),
    getTransactionReceipt: jest.fn(async (txHash: string) => {
      const r = receipts.get(txHash.toLowerCase())
      if (!r) return null
      const tx = submittedTxs.get(txHash.toLowerCase())
      return {
        hash: r.txHash,
        status: r.status === 'success' ? 1 : 0,
        from: tx?.from ?? '',
        to: tx?.to ?? '',
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        index: 0,
      }
    }),
    getTransaction: jest.fn(async (txHash: string) => {
      const tx = submittedTxs.get(txHash.toLowerCase())
      if (!tx) return null
      return {
        hash: tx.hash!,
        from: tx.from!,
        to: tx.to!,
        chainId: tx.chainId,
        value: tx.value,
        data: tx.data,
        blockNumber: 10,
        index: 0,
      }
    }),
  } as any

  const overrides = {
    gasLimit: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    chainId: CHAIN_ID,
  }

  return {
    balances,
    nonces,
    receipts,
    submittedTxs,
    httpClient,
    provider,
    overrides,
    blockHash,
  }
}

describe('Durable Forum preparation ownership and handoff', () => {
  it('retains a durable preparation hold for single-funder Forum preparation across Phase 1 and Phase 2, isolating the sub-account from unrelated spenders until handoff or cancel', async () => {
    const h = makeHarness()
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const store = new InMemorySubAccountPoolStore()
    const pool = new MonadSubAccountPool({
      keyring,
      store,
      expectedChainId: CHAIN_ID,
    })
    const mainWallet = new Wallet('0x' + '11'.repeat(32))
    h.balances.set(mainWallet.address.toLowerCase(), 10_000_000n)
    const mainSigner = new MonadAccountTxSigner({
      privateKey: mainWallet.privateKey,
      provider: h.provider,
      httpClient: h.httpClient,
    })

    const opId = 'wallet:topic:0xdeadbeef00000001'
    const prep = await pool.prepareBurnAccount({
      mainAccountSigner: mainSigner,
      provider: h.provider,
      burnValueWei: 1_000n,
      gasReserveWei: 21_000n,
      fundingOverrides: h.overrides,
      receipt: { maxAttempts: 1, intervalMs: 1 },
      claimFor: opId,
      retainPreparationHold: true,
    })

    // Release the in-memory claim to simulate a process restart in Phase 2 (after funding, before lease/journal).
    pool.releaseClaim(opId)

    const heldRecord = pool.getRecord(prep.index)!
    expect(heldRecord.status).toBe('available')
    expect(heldRecord.funding?.hold).toEqual({
      operationId: opId,
      expectedContributors: 1,
      targetWei: '22000',
      chainId: String(CHAIN_ID),
      requirements: [
        {
          funder: mainWallet.address,
          valueWei: '22000',
        },
      ],
    })

    // Unrelated stamp selection, capacity queries, and another burn preparation must not steal the held account.
    expect(pool.isSpendReserved(prep.index)).toBe(true)
    expect(pool.isSpendReserved(prep.index, 'other-op')).toBe(true)
    expect(pool.isSpendReserved(prep.index, opId)).toBe(false)
    expect(pool.selectForStamp()).toBeUndefined()
    expect(
      await pool.fundedCapacities(h.provider, 21_000n, { holder: 'other-op' }),
    ).toEqual([])
    expect(
      await pool.fundedCapacities(h.provider, 21_000n, { holder: opId }),
    ).toEqual([
      {
        index: prep.index,
        address: heldRecord.address,
        capacityWei: 1_000n,
      },
    ])

    // Explicit Resume with the same operationId reuses the held sub-account without funding a new one.
    const submitCallsBeforeResume =
      h.httpClient.submitRawTransaction.mock.calls.length
    const resumed = await pool.prepareBurnAccount({
      mainAccountSigner: mainSigner,
      provider: h.provider,
      burnValueWei: 1_000n,
      gasReserveWei: 21_000n,
      fundingOverrides: h.overrides,
      receipt: { maxAttempts: 1, intervalMs: 1 },
      claimFor: opId,
      retainPreparationHold: true,
    })
    expect(resumed.index).toBe(prep.index)
    expect(h.httpClient.submitRawTransaction.mock.calls.length).toBe(
      submitCallsBeforeResume,
    )
    pool.releaseClaim(opId)

    // Explicit Cancel clears the hold and releases the funded sub-account back to normal pool availability.
    const topicJournal = new InMemoryTopicOperationJournal()
    const cancelled = await pool.cancelHeldPreparation(opId, { topicJournal })
    expect(cancelled.status).toBe('available')
    expect(cancelled.funding?.hold).toBeUndefined()
    expect(pool.isSpendReserved(prep.index)).toBe(false)
    expect(pool.selectForStamp()?.index).toBe(prep.index)
  })

  it('resumes an interrupted multi-funder Forum preparation from the exact remaining contributor without re-sending contributor 0', async () => {
    const h = makeHarness()
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const store = new InMemorySubAccountPoolStore()
    const pool = new MonadSubAccountPool({
      keyring,
      store,
      expectedChainId: CHAIN_ID,
    })

    const funderAWallet = new Wallet('0x' + '21'.repeat(32))
    const funderBWallet = new Wallet('0x' + '22'.repeat(32))
    h.balances.set(funderAWallet.address.toLowerCase(), 500_000n)
    h.balances.set(funderBWallet.address.toLowerCase(), 500_000n)

    const signerA = new MonadAccountTxSigner({
      privateKey: funderAWallet.privateKey,
      provider: h.provider,
      httpClient: h.httpClient,
    })
    const signerB = new MonadAccountTxSigner({
      privateKey: funderBWallet.privateKey,
      provider: h.provider,
      httpClient: h.httpClient,
    })

    const opId = 'wallet:topic:multi-resume-1'
    let failB = true
    const origSubmit = h.httpClient.submitRawTransaction.getMockImplementation()!
    h.httpClient.submitRawTransaction.mockImplementation(async (rawTx: string) => {
      const tx = Transaction.from(rawTx)
      if (
        failB &&
        tx.from?.toLowerCase() === funderBWallet.address.toLowerCase()
      ) {
        throw new Error('simulated crash during contributor B submit')
      }
      return origSubmit(rawTx)
    })

    await expect(
      pool.prepareBurnAccount({
        mainAccountSigner: signerA,
        funders: [
          { signer: signerA, amountWei: 10_000n, source: 'main' },
          { signer: signerB, amountWei: 12_000n, source: 'identity' },
        ],
        provider: h.provider,
        burnValueWei: 1_000n,
        gasReserveWei: 21_000n,
        fundingOverrides: h.overrides,
        receipt: { maxAttempts: 1, intervalMs: 1 },
        claimFor: opId,
        retainPreparationHold: true,
      }),
    ).rejects.toThrow('simulated crash during contributor B submit')

    // Sub-account 0 has contributor A included+success and contributor B registered as unresolved.
    const midRecord = pool.getRecord(0)!
    expect(midRecord.status).toBe('funding')
    expect(midRecord.funding?.hold?.operationId).toBe(opId)
    expect(midRecord.funding?.attempts).toHaveLength(2)
    expect(midRecord.funding?.attempts[0]?.observation.kind).toBe('included')
    expect(midRecord.funding?.attempts[1]?.observation.kind).toBe('unresolved')

    // Now allow contributor B's exact signed tx to be resubmitted and confirmed on resume.
    failB = false
    const resumed = await pool.prepareBurnAccount({
      mainAccountSigner: signerB,
      funders: [
        { signer: signerA, amountWei: 10_000n, source: 'main' },
        { signer: signerB, amountWei: 12_000n, source: 'identity' },
      ],
      provider: h.provider,
      burnValueWei: 1_000n,
      gasReserveWei: 21_000n,
      fundingOverrides: h.overrides,
      receipt: { maxAttempts: 1, intervalMs: 1 },
      claimFor: opId,
      retainPreparationHold: true,
    })

    expect(resumed.index).toBe(0)
    const completed = pool.getRecord(0)!
    expect(completed.status).toBe('available')
    expect(completed.funding?.attempts).toHaveLength(2)
    expect(completed.funding?.hold?.operationId).toBe(opId)
    // Contributor A was only ever signed and submitted once (nonce 0).
    expect(h.nonces.get(funderAWallet.address.toLowerCase())).toBe(1)
    expect(h.nonces.get(funderBWallet.address.toLowerCase())).toBe(1)
  })

  it('completes atomic handoff from held preparation to TopicOperationJournal and recovers across pre-acknowledge and post-spent settlement crashes', async () => {
    const h = makeHarness()
    const location = mkdtempSync(join(tmpdir(), 'forum-prep-handoff-'))
    const db = level(location)
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const changeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const poolStore = new InMemorySubAccountPoolStore()
    const pool = new MonadSubAccountPool({
      keyring,
      store: poolStore,
      expectedChainId: CHAIN_ID,
    })
    const changePool = new MonadChangePool({
      keyring: changeKeyring,
      store: new InMemoryChangePoolStore(),
    })
    const topicJournal = new LevelTopicOperationJournal(db, () => {})
    await topicJournal.Open()
    const leaseManager = new SubAccountLeaseManager(pool)

    const bundle = await openExistingPoolMonadTopicOwner({
      pool,
      changePool,
      leaseManager,
      subKeyring: keyring,
      changeKeyring,
      nativeBinding: {
        chainIdentifier: 'monad-testnet',
        nativeChainId: String(CHAIN_ID),
        publicTuple: JSON.stringify({
          mainAddress: keyring.deriveSubAccount(0).address.toLowerCase(),
        }),
      },
      stampReferencesLeaseIndex: () => false,
      assertEnclosingAdmission: () => {},
    })

    const walletState = {
      pool,
      leaseManager,
      topicOperationJournal: topicJournal,
      runOperation: async (operation: (admission: any) => Promise<unknown>) =>
        operation(undefined),
      compactTerminalAccounts: async () => 0,
    } as any

    const mainWallet = new Wallet('0x' + '31'.repeat(32))
    h.balances.set(mainWallet.address.toLowerCase(), 10_000_000n)
    const mainSigner = new MonadAccountTxSigner({
      privateKey: mainWallet.privateKey,
      provider: h.provider,
      httpClient: h.httpClient,
    })

    const opId = 'wallet:topic:handoff-1'
    const prep = await pool.prepareBurnAccount({
      mainAccountSigner: mainSigner,
      provider: h.provider,
      burnValueWei: 1_000n,
      gasReserveWei: 100_000n,
      fundingOverrides: h.overrides,
      receipt: { maxAttempts: 1, intervalMs: 1 },
      claimFor: opId,
      retainPreparationHold: true,
    })

    expect(pool.getRecord(prep.index)?.funding?.hold?.operationId).toBe(opId)

    // Verify inputAdmission projects a `pool-retained` `hold` claim for the held `available` sub-account.
    const preHandoffInspection = await bundle.runLifetime(async lifetime =>
      bundle.inputAdmission.inspect(lifetime),
    )
    expect(preHandoffInspection.status).toBe('ready')
    if (preHandoffInspection.status !== 'ready') {
      throw new Error('Expected ready inspection')
    }
    expect(
      preHandoffInspection.obligations.some(
        c =>
          c.provenance.kind === 'pool-retained' &&
          c.provenance.poolIndex === prep.index &&
          c.provenance.role === 'hold',
      ),
    ).toBe(true)

    // Build a canonical post frame.
    const postFrame = encodeForumPost({
      network: 'monad-testnet',
      topic: 'general',
      entries: [{ kind: 'post', message: 'hello durable handoff' }],
      authored: { seconds: 1_700_000_000n, nanoseconds: 0 },
    })
    const targetHash = topicBurnCommitment(postFrame).hash

    const walletHandle: EvmWalletHandle = {
      pool,
      leaseManager,
      topicOperationJournal: topicJournal,
      walletState,
      provider: h.provider,
      httpClient: h.httpClient,
      relayBaseUrl: 'http://localhost:9999',
      cborNetwork: 'monad-testnet',
      forumBurnAddress: BURN_ADDRESS,
      forumChainId: CHAIN_ID,
    } as any

    // Simulate a second wrapper sharing the same LevelDB to test stale journal cache reload.
    const staleJournalView = new LevelTopicOperationJournal(db, () => {})
    await staleJournalView.Open()

    let putCalls = 0
    const mockExchange = jest.fn(async (config: any) => {
      putCalls++
      const reqBytes = new Uint8Array(config.data)
      if (putCalls === 1) {
        throw new Error('simulated relay timeout after journal handoff')
      }
      // On reconciliation, ensure the burn tx is in submittedTxs & receipts and return state=2 confirmed CBOR status.
      const operations = topicJournal.getAll()
      const op = operations[0]!
      await h.httpClient.submitRawTransaction(op.rawTx)
      const parsedBurnTx = Transaction.from(op.rawTx)
      const statusBytes = encodeForumReadFrame(
        46,
        new Map<number, Encodable>([
          [0, 'monad-testnet'],
          [1, reqBytes],
          [2, targetHash],
          [3, Uint8Array.from(Buffer.from(op.txHash.slice(2), 'hex'))],
          [4, Uint8Array.from(Buffer.from(op.senderAddress.slice(2), 'hex'))],
          [5, Buffer.from(parsedBurnTx.data.slice(2), 'hex')[5]!],
          [6, BigInt(op.valueWei)],
          [7, 2],
          [8, 10],
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

    mockedAxios.mockImplementation(mockExchange)

    try {
      await expect(
        submitForumOperation(walletHandle, {
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
          leaseIndex: prep.index,
          leaseHolder: opId,
          encode: rawTx => encodeTopicPostSubmission(postFrame, rawTx),
        }),
      ).rejects.toThrow('Forum operation retained pending')

      // Verify atomic handoff completed:
      // 1. TopicOperationJournal has the entry with preparationId & preparationRevision.
      const journaled = topicJournal.getAll()
      expect(journaled).toHaveLength(1)
      expect(journaled[0]?.preparationId).toBe(opId)
      expect(journaled[0]?.preparationRevision).toBeGreaterThanOrEqual(1)

      // 2. Pool record is `in-use`, `funding.hold` is cleared, and `lifecycle.spend` is recorded.
      const handedOffRecord = pool.getRecord(prep.index)!
      expect(handedOffRecord.status).toBe('in-use')
      expect(handedOffRecord.funding?.hold).toBeUndefined()
      expect(handedOffRecord.lifecycle?.spend?.txHash).toBe(
        journaled[0]?.txHash,
      )

      // 3. Stale journal wrapper must reload from LevelDB before authorizing unused lease release.
      expect(staleJournalView.referencesLeaseIndex(prep.index)).toBe(false)
      await staleJournalView.reload()
      expect(staleJournalView.referencesLeaseIndex(prep.index)).toBe(true)

      // 4. Simulate crash between TopicOperationJournal.put and acknowledgePreparationHandoff:
      // Restore `funding.hold` and remove `lifecycle.spend` on the pool row while journal entry exists.
      await poolStore.mutate(snapshot => {
        const cur = snapshot.records.find(r => r.index === prep.index)!
        const unhandedOff = {
          index: cur.index,
          address: cur.address,
          status: 'available' as const,
          funding: {
            version: 1 as const,
            attempts: cur.funding!.attempts,
            hold: {
              operationId: opId,
              expectedContributors: 1,
            },
          },
        }
        return {
          records: [
            { record: unhandedOff, expectedRevision: cur.revision ?? 0 },
          ],
          result: unhandedOff,
        }
      })
      await poolStore.flush()

      expect(pool.getRecord(prep.index)?.status).toBe('available')
      expect(pool.getRecord(prep.index)?.funding?.hold?.operationId).toBe(opId)
      expect(pool.getRecord(prep.index)?.lifecycle?.spend).toBeUndefined()

      // Reconcile repairs the handoff (`in-use` + `lifecycle.spend` + `hold` cleared), exchanges, and settles to `spent`.
      await reconcileForumOperations(walletHandle, 'post')
      expect(topicJournal.getAll()).toHaveLength(0)
      expect(pool.getRecord(prep.index)?.status).toBe('spent')
      expect(pool.getRecord(prep.index)?.funding?.hold).toBeUndefined()
      expect(pool.getRecord(prep.index)?.lifecycle?.spend?.txHash).toBe(
        journaled[0]?.txHash,
      )

      // 5. Simulate crash during settle after pool row became `spent` before `topicOperationJournal.delete`:
      await topicJournal.put(journaled[0]!)
      const callsBefore = mockExchange.mock.calls.length
      await reconcileForumOperations(walletHandle, 'post')
      expect(mockExchange.mock.calls.length).toBe(callsBefore + 1)
      expect(topicJournal.getAll()).toHaveLength(0)
    } finally {
      mockedAxios.mockReset()
      await db.close()
      rmSync(location, { recursive: true, force: true })
    }
  })

  it('distinguishes TopicBurnPreparationError with recorded funding contributions from pre-send failures', () => {
    const preSendErr = new TopicBurnPreparationError('RPC down')
    expect(preSendErr.fundingRecorded).toBe(false)
    expect(preSendErr.message).toContain('Nothing was sent.')

    const midFundingErr = new TopicBurnPreparationError(
      'Contributor 2 timed out',
      {
        fundingRecorded: true,
      },
    )
    expect(midFundingErr.fundingRecorded).toBe(true)
    expect(midFundingErr.message).not.toContain('Nothing was sent.')
    expect(midFundingErr.message).toContain(
      'Recorded funding contributions are retained on the sub-account',
    )
  })
})

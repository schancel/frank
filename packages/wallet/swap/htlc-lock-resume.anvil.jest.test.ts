/**
 * INTEGRATION: an HTLC lock sent through the wallet's contract-call path (`sendContractCall`, the
 * native operation journal, an `htlc` record) against GenericHTLC v2 deployed from its compiled
 * artifact on a real EVM node: `anvil` as `monad-regtest` (chain ID 20143), whose contracts are
 * deployed per run and reach the wallet through the chain configuration (`contracts.htlc`), as a
 * regtest run's do.
 *
 * The wallet is stopped after it signed the lock and handed the bytes out (the journal holds them
 * as exposed) but before the node had them: every `eth_sendRawTransaction` fails, as when the
 * process dies mid-send, and the wallet is closed there. A wallet reopened from the same seed
 * finds the row, re-sends exactly the same signed bytes, and the lock lands once at the id both
 * parties compute from the terms (`htlcLockId`), read back with `readHtlcLock`. The hash lock is
 * the sha256 of the account's own derived preimage (`swapSecretCapabilityOf`), which the reopened
 * handle derives identically. The same call to any other contract is refused unsigned.
 *
 * Real: the node, the contract, signing, the wallet's provider, the native journal and its Level
 * stores. No relay and nothing standing in for one: the wallet is opened with the host's own
 * sync delivery hook (`emitWalletSync`), which here records the note to self instead of sending
 * it, so the note's items are checked as the wallet composed them. Only the RPC URL is redirected
 * (to the anvil node).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  ContractFactory,
  JsonRpcProvider,
  Transaction,
  Wallet,
  getBytes,
  sha256,
} from 'ethers'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import type {
  HtlcRecordItem,
  MessageItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { MonadRootBundle } from '../evm-wallet-material'
import {
  createEvmChain,
  swapSecretCapabilityOf,
  type EvmChainConfig,
} from '../chain/evm-chain'
import { InMemoryNativeTransactionAttemptStore } from '../chain/chain-wallet'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import {
  HTLC_NATIVE_TOKEN,
  encodeHtlcLock,
  evmHtlcInterface,
  htlcLockId,
  readHtlcLock,
  type EvmHtlcTerms,
} from '../swap-escrow'
import type { EvmHtlcCallRecord } from '../storage/evm-native-operation-journal'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: mockNode.url,
        chainId: options.chainId,
      }),
  }
})

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(
      root,
      `anvil-${process.platform}-${arch}`,
      'bin',
      'anvil',
    )
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** The public domain-root test vectors: published test data, not any account's keys. */
function roots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index]!.outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** monad-regtest's registry minimum gas price (docs/protocol/chains/v1.json). */
const GAS_PRICE = 100n * 10n ** 9n
const POLICY = 'xec-monad-regtest-proof-v2'
const SWAP_ID = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16))
const SWAP_ID_HEX = Buffer.from(SWAP_ID).toString('hex')

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: htlc-lock-resume.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

suite(
  'an HTLC lock killed after signing is resumed and lands once, on a real EVM node (anvil)',
  () => {
    jest.setTimeout(300_000)
    let node: ChildProcess
    let chain: JsonRpcProvider
    let dev: Wallet
    let directory: string
    let open: () => Promise<EvmChainWalletHandle>
    let alice: EvmChainWalletHandle
    let main: string
    let htlc: string
    /** The notes to self the wallet handed its host, as composed. */
    let notes: MessageItem[][]

    beforeEach(async () => {
      const port = await freePort()
      mockNode.url = `http://127.0.0.1:${port}`
      node = spawn(
        anvilBin!,
        [
          '--port',
          String(port),
          '--chain-id',
          '20143',
          '--base-fee',
          '0',
          '--gas-price',
          String(GAS_PRICE),
          '--silent',
        ],
        { stdio: 'ignore' },
      )
      chain = new JsonRpcProvider(mockNode.url, 20143, {
        staticNetwork: true,
        cacheTimeout: -1,
      })
      for (let attempt = 0; ; attempt++) {
        try {
          await chain.getBlockNumber()
          break
        } catch (error) {
          if (attempt > 100) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      dev = new Wallet(DEV_KEY, chain)
      const deployed = await new ContractFactory(
        GenericHTLCArtifact.abi,
        GenericHTLCArtifact.bytecode,
        dev,
      ).deploy()
      await deployed.waitForDeployment()
      htlc = await deployed.getAddress()
      notes = []
      directory = mkdtempSync(join(tmpdir(), 'frank-htlc-lock-resume-'))
      const config: EvmChainConfig = {
        networkId: 'monad-regtest',
        rpcChain: 'monad-regtest',
        localNodeWithoutSpendRule: true,
        chainId: 20143,
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        // Never contacted: the host's hook below carries the wallet's notes.
        relayBaseUrl: 'http://127.0.0.1:1',
        networkTag: 'MONR',
        contracts: { htlc },
        stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
        resolveDefaultStamp: fixedStampDefault(10n ** 15n),
        defaultTopicVoteValueWei: 1_000n,
        subAccountPoolSize: 0,
        walletStorageLocation: join(directory, 'wallet'),
        emitWalletSync: async (
          item: WalletSyncItem,
          record: MessageItem | undefined,
        ) => {
          notes.push(record ? [item, record] : [item])
        },
      }
      // One chain, as one host process; a restart opens the same storage again.
      open = async () =>
        (await createEvmChain(config).createWallet(
          roots(0),
        )) as EvmChainWalletHandle
      alice = await open()
      main = (await alice.getReceiveAddress()).raw.toLowerCase()
      await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
      for (let i = 0; i < 4; i++) await chain.send('evm_mine', [])
    })
    afterEach(async () => {
      jest.restoreAllMocks()
      await alice?.close().catch(() => undefined)
      chain?.destroy()
      node?.kill()
      rmSync(directory, { recursive: true, force: true })
    })

    /** Every provider here, the wallet's own included, sends through this. `deliver` false: the
     * raw transaction never reaches the node and the send fails. */
    function watchBroadcasts(deliver: boolean) {
      const offered: string[] = []
      const send = JsonRpcProvider.prototype.send
      const spy = jest
        .spyOn(JsonRpcProvider.prototype, 'send')
        .mockImplementation(async function (
          this: JsonRpcProvider,
          method,
          params,
        ) {
          if (method === 'eth_sendRawTransaction') {
            offered.push(String((params as string[])[0]).toLowerCase())
            if (!deliver) throw new Error('the process stopped mid-send')
          }
          return send.call(this, method, params)
        })
      return { offered, restore: () => spy.mockRestore() }
    }
    const lockedEvents = async (lockId: string) =>
      (
        await chain.getLogs({
          address: htlc,
          topics: [evmHtlcInterface.getEvent('Locked')!.topicHash, lockId],
          fromBlock: 0,
          toBlock: 'latest',
        })
      ).length

    async function lockTerms() {
      const preimage = swapSecretCapabilityOf(alice)!.swapPreimage({
        policyName: POLICY,
        swapId: SWAP_ID,
      })
      const terms: EvmHtlcTerms = {
        recipient: Wallet.createRandom().address,
        refundAddress: main,
        token: HTLC_NATIVE_TOKEN,
        amount: 10n ** 15n,
        hashLock: sha256(preimage),
        expiresAt: BigInt((await chain.getBlock('latest'))!.timestamp + 3600),
      }
      preimage.fill(0)
      const lockId = htlcLockId(main, terms).toLowerCase()
      const record: EvmHtlcCallRecord = {
        kind: 'htlc',
        action: 'lock',
        swapId: SWAP_ID_HEX,
        lockId,
      }
      return { terms, lockId, record, call: encodeHtlcLock(htlc, terms) }
    }

    it("refuses an htlc lock to any contract but the network's GenericHTLC, signing nothing", async () => {
      const { terms, record } = await lockTerms()
      // The same lock, encoded for another contract (the contract's own code, elsewhere).
      const other = await new ContractFactory(
        GenericHTLCArtifact.abi,
        GenericHTLCArtifact.bytecode,
        dev,
      ).deploy()
      await other.waitForDeployment()
      const call = encodeHtlcLock(await other.getAddress(), terms)
      const watched = watchBroadcasts(true)
      await expect(
        alice.sendContractCall!({
          to: { raw: call.to },
          data: call.data,
          value: call.value,
          gasLimit: 300_000n,
          record,
        }),
      ).rejects.toMatchObject({ code: 'invalid', validation: 'record' })
      watched.restore()
      expect(watched.offered).toEqual([])
      expect(
        alice.getNativeOperations!().filter(r => r.kind === 'contract'),
      ).toEqual([])
    })

    it('re-sends the same signed bytes after a restart, and the lock lands exactly once', async () => {
      const { terms, lockId, record, call } = await lockTerms()
      const nonce = await chain.getTransactionCount(main, 'latest')

      // Signed, journaled and handed out; the node never got it, and the wallet stops there.
      const killed = watchBroadcasts(false)
      let signedHash: string | undefined
      const failure = await alice.sendContractCall!({
        to: { raw: call.to },
        data: call.data,
        value: call.value,
        gasLimit: 300_000n,
        record,
        onSigned: async signed => {
          signedHash = signed.txHash
        },
      }).then(
        () => undefined,
        error => error as Error,
      )
      expect(failure).toBeInstanceOf(Error)
      const row = alice.getNativeOperations!().find(
        r => r.kind === 'contract' && r.record?.kind === 'htlc',
      )!
      expect(row.record).toEqual(record)
      const member = row.members[0]!
      expect(member.exposed).toBe(true)
      const raw = member.signed!.rawTransaction.toLowerCase()
      expect(member.signed!.transactionHash).toBe(signedHash)
      expect(Transaction.from(raw)).toMatchObject({
        nonce,
        to: call.to,
        data: call.data,
        value: call.value,
      })
      expect(killed.offered.length).toBeGreaterThan(0)
      expect(new Set(killed.offered)).toEqual(new Set([raw]))
      await alice.close()
      killed.restore()
      expect(
        await chain.getTransaction(member.signed!.transactionHash),
      ).toBeNull()
      expect(await readHtlcLock(chain, htlc, lockId)).toBeNull()

      // The same account, opened again: the row is there, as signed, and is resumed.
      const resumed = watchBroadcasts(true)
      alice = await open()
      const reopened = alice.getNativeOperations!().find(
        r => r.operationId === row.operationId,
      )!
      expect(reopened.record).toEqual(record)
      expect(reopened.members[0]!.signed!.rawTransaction.toLowerCase()).toBe(
        raw,
      )
      // The reopened handle derives the same preimage: the hash lock is the account's own.
      expect(
        sha256(
          swapSecretCapabilityOf(alice)!.swapPreimage({
            policyName: POLICY,
            swapId: SWAP_ID,
          }),
        ),
      ).toBe(terms.hashLock)
      await alice.resumeNativeOperation!(row.operationId)
      await chain.send('evm_mine', [])
      const receipt = await chain.getTransactionReceipt(
        member.signed!.transactionHash,
      )
      expect(receipt?.status).toBe(1)

      // Resumed again: nothing new is signed; at most the same bytes are offered.
      await alice.resumeNativeOperation!(row.operationId).catch(() => undefined)
      await alice.reobserveNativeOperations?.()
      resumed.restore()
      expect(resumed.offered.length).toBeGreaterThan(0)
      expect(new Set(resumed.offered)).toEqual(new Set([raw]))

      const lock = await readHtlcLock(chain, htlc, lockId)
      expect(lock).toMatchObject({
        lockId,
        state: 'open',
        amount: terms.amount,
        hashLock: terms.hashLock,
        expiresAt: terms.expiresAt,
        preimage: null,
      })
      expect(lock!.sender.toLowerCase()).toBe(main)
      expect(await lockedEvents(lockId)).toBe(1)
      expect(await chain.getBalance(htlc)).toBe(terms.amount)
      expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 1)
      expect(alice.getUnresolvedContractCalls!()).toEqual([])

      // Included: the note to self carries the record beside the lock's wallet-sync item.
      await alice.flushNativeSync?.()
      const note = notes.find(items =>
        items.some(item => item.type === 'htlc-record'),
      )
      expect(note).toBeDefined()
      expect(note![0]).toMatchObject({
        type: 'wallet-sync',
        chainIdentifier: 'monad-regtest',
        txHash: member.signed!.transactionHash,
      })
      expect(note![1]).toEqual({
        type: 'htlc-record',
        chainIdentifier: 'monad-regtest',
        action: 'lock',
        swapId: SWAP_ID_HEX,
        lockId,
        txHash: member.signed!.transactionHash,
        timestamp: (note![1] as HtlcRecordItem).timestamp,
      })
    })
  },
)

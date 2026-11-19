/**
 * INTEGRATION: what a contract call's receipt does to the wallet's coins, on the device that sent
 * it and on another device of the same account, against GenericHTLC v2 deployed from its compiled
 * artifact on a real EVM node (`anvil` as `monad-regtest`, chain ID 20143).
 *
 * The device that sends the call settles the spend from the receipt it reads, as it settles a
 * native payment's (`EvmCoinList.recordMined`, AGENTS.md §3): the coin at the call's nonce is
 * spent and never selectable again, and the account's next nonce is a coin holding what remains
 * (what the coin held, less the value moved and the fee; a reverted call moves no value). No
 * balance poll is needed for it: the coin list itself shows the chain's balance at once.
 *
 * A call that lands but reverts still pays its fee. The account's other devices are told of that
 * fee by the same wallet-sync note an included call's is (`applySync`); a device applies it once,
 * through the self-note path (`consumeEvmSelfNotes` → `applyWalletSyncItem`), and a repeat of the
 * note changes nothing.
 *
 * Real: the node, the contract, signing, the wallet's provider, the coin list, the native
 * journal and their Level stores. No relay: the wallet is opened with the host's own sync delivery
 * hook (`emitWalletSync`), which records the note to self instead of sending it, and the other
 * device reads it as its inbox would.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { ContractFactory, JsonRpcProvider, Transaction, Wallet, getBytes, sha256 } from 'ethers'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import type { MessageItem, WalletSyncItem } from '@frank/cashweb/types/messages'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { MonadRootBundle } from '../evm-wallet-material'
import { evmWalletInternals } from '../evm-wallet'
import { consumeEvmSelfNotes } from '../evm-received-coin-manager'
import { createEvmChain, type EvmChainConfig } from './evm-chain'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import type { DirectMessageReceived } from './active-chain'
import { withDefaultMessageItems } from './message-items.testutil'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import { HTLC_NATIVE_TOKEN, encodeHtlcLock, htlcLockId, type EvmHtlcTerms } from '../swap-escrow'
import type { EvmHtlcCallRecord } from '../storage/evm-native-operation-journal'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN)) return process.env.ANVIL_BIN
  try {
    const root = dirname(dirname(require.resolve('@foundry-rs/anvil/package.json')))
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil')
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
  const root = <P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption'>(purpose: P) => ({
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
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** monad-regtest's registry minimum gas price (docs/protocol/chains/v1.json). */
const GAS_PRICE = 100n * 10n ** 9n
const FUNDED = 10n ** 18n
const LOCKED = 10n ** 15n

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: evm-contract-call-receipt.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.')
const suite = anvilBin ? describe : describe.skip

suite('a contract call’s receipt settles its account’s coins on every device (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let directory: string
  let htlc: string
  let config: EvmChainConfig
  /** Device A: the device that sends. */
  let alice: EvmChainWalletHandle
  let main: string
  /** The notes to self device A handed its host, as composed. */
  let notes: MessageItem[][]

  /** One device of the account: its own storage, the same seed. One process holds one open
   * handle of an account, so the devices take turns, as two machines would each run one. */
  const openDevice = async (name: string) =>
    (await withDefaultMessageItems(
      createEvmChain({ ...config, walletStorageLocation: join(directory, name) }),
    ).createWallet(roots(0))) as EvmChainWalletHandle

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '20143', '--base-fee', '0', '--gas-price', String(GAS_PRICE), '--silent'],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 20143, { staticNetwork: true, cacheTimeout: -1 })
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
    const deployed = await new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev).deploy()
    await deployed.waitForDeployment()
    htlc = await deployed.getAddress()
    notes = []
    directory = mkdtempSync(join(tmpdir(), 'frank-contract-call-receipt-'))
    config = {
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
      emitWalletSync: async (item: WalletSyncItem, record: MessageItem | undefined) => {
        notes.push(record ? [item, record] : [item])
      },
    }
    alice = await openDevice('device-a')
    main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: FUNDED })).wait()
    for (let i = 0; i < 4; i++) await chain.send('evm_mine', [])
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
    rmSync(directory, { recursive: true, force: true })
  })

  /** A native-coin lock of `LOCKED` wei from the main account, expiring `expiresIn` seconds after
   * the newest block: a lock already expired reverts on chain (`InvalidExpiry`), its value kept. */
  async function lock(expiresIn: number) {
    const terms: EvmHtlcTerms = {
      recipient: Wallet.createRandom().address,
      refundAddress: main,
      token: HTLC_NATIVE_TOKEN,
      amount: LOCKED,
      hashLock: sha256(Uint8Array.from({ length: 32 }, (_, i) => i + expiresIn)),
      expiresAt: BigInt((await chain.getBlock('latest'))!.timestamp + expiresIn),
    }
    const record: EvmHtlcCallRecord = {
      kind: 'htlc',
      action: 'lock',
      swapId: 'ab'.repeat(32),
      lockId: htlcLockId(main, terms).toLowerCase(),
    }
    const call = encodeHtlcLock(htlc, terms)
    const nonce = await chain.getTransactionCount(main, 'latest')
    // What the user saw before calling: the wallet's spendable figure, which lists the main
    // account's coin at this nonce.
    await alice.getSpendableBalance!()
    expect(evmWalletInternals(alice).coinList!.latestOf(main)).toMatchObject({ nonce, state: 'unspent' })
    const handle = await alice.sendContractCall!({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      // Given: a call the node would revert cannot have its gas estimated.
      gasLimit: 300_000n,
      record,
    })
    // The host's watch of the call it just sent: the wallet's one look at the chain for it.
    await alice.watchNativeOperation!(handle.operationId)
    const row = alice.getNativeOperations!().find(candidate => candidate.operationId === handle.operationId)!
    const receipt = (await chain.getTransactionReceipt(handle.txHash))!
    return { handle, row, nonce, receipt, fee: receipt.gasUsed * receipt.gasPrice }
  }

  /** What the sending device's coin list shows of the main account at once, with no chain read:
   * `[main, nonce]` spent, the next nonce unspent at what the chain holds, nothing to read. */
  async function expectSettledFromReceipt(device: EvmChainWalletHandle, nonce: number) {
    const internals = evmWalletInternals(device)
    const list = internals.coinList!
    const reads: string[] = []
    const send = JsonRpcProvider.prototype.send
    const spy = jest
      .spyOn(JsonRpcProvider.prototype, 'send')
      .mockImplementation(async function (this: JsonRpcProvider, method, params) {
        reads.push(method)
        return send.call(this, method, params)
      })
    let spendable: bigint
    try {
      // The old pair is spent and can never be selected again.
      expect(list.get(main, nonce)?.state).toBe('spent')
      const next = list.latestOf(main)!
      expect(next).toMatchObject({ nonce: nonce + 1, state: 'unspent' })
      expect(internals.coinListSync!.isDirty(main)).toBe(false)
      // What a send can draw on now, as selection sees it: no account is read for it.
      spendable = await device.transactionSetPreparer!.spendableNowWei()
      expect(reads.filter(method => method === 'eth_getBalance' || method === 'eth_getTransactionCount')).toEqual([])
    } finally {
      spy.mockRestore()
    }
    const next = list.latestOf(main)!
    expect(next.valueWei).toBe(await chain.getBalance(main))
    expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 1)
    expect(spendable).toBeGreaterThan(0n)
    // A full read of the chain finds nothing to change.
    expect(await device.getSpendableBalance!()).toBe(spendable)
    expect(list.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: next.valueWei })
    return spendable
  }

  /** Device A's note to self, as device B's inbox reads it. */
  const selfNote = (device: EvmChainWalletHandle, items: MessageItem[]) =>
    ({
      senderAddress: { raw: device.identity.address.raw },
      recipientAddress: { raw: device.identity.address.raw },
      items,
      payloadDigest: 'cd'.repeat(32),
      stampValueWei: 0n,
      receivedTime: Date.now(),
    }) as unknown as DirectMessageReceived

  it('a call that lands: the sending device lists the account’s next coin from the receipt, the value and fee taken off', async () => {
    const before = await chain.getBalance(main)
    const { row, nonce, receipt, fee } = await lock(3600)
    expect(receipt.status).toBe(1)
    expect(row.members[0]!.observation.state).toBe('included-success')
    expect(await chain.getBalance(main)).toBe(before - LOCKED - fee)
    await expectSettledFromReceipt(alice, nonce)
    // The note to self: the value and the fee in the debit, the record beside it.
    await alice.flushNativeSync!()
    const note = notes.find(items => (items[0] as WalletSyncItem).txHash === receipt.hash)!
    expect(note[0]).toMatchObject({
      spentInputs: [{ address: main, nonce, valueWei: (LOCKED + fee).toString() }],
      createdOutputs: [{ valueWei: LOCKED.toString() }],
    })
    expect(note[1]).toMatchObject({ type: 'htlc-record', action: 'lock' })
    // Device A reads its own note too: its list already shows the spend and does not change.
    const listed = evmWalletInternals(alice).coinList!.latestOf(main)
    expect(await consumeEvmSelfNotes(alice, selfNote(alice, note))).toMatchObject({ kind: 'consumed' })
    expect(evmWalletInternals(alice).coinList!.latestOf(main)).toEqual(listed)
    expect(evmWalletInternals(alice).coinListSync!.isDirty(main)).toBe(false)
    // And a restart reads the same.
    await alice.close()
    alice = await openDevice('device-a')
    expect(evmWalletInternals(alice).coinList!.get(main, nonce)?.state).toBe('spent')
    expect(evmWalletInternals(alice).coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: await chain.getBalance(main) })
  })

  it('a call that reverts: the sending device keeps the value and takes off only the fee, and the other device learns that fee once', async () => {
    // Device B first sees the main account holding what it was funded with.
    await alice.close()
    let deviceB = await openDevice('device-b')
    const fundedB = await deviceB.getBalance()
    expect(fundedB).toBe(FUNDED)
    await deviceB.close()
    alice = await openDevice('device-a')

    const { row, nonce, receipt, fee } = await lock(-60)
    expect(receipt.status).toBe(0)
    expect(fee).toBeGreaterThan(0n)
    expect(row.members[0]!.observation.state).toBe('included-revert')
    // Nothing was locked: the account paid the fee, no more.
    expect(await chain.getBalance(main)).toBe(FUNDED - fee)
    const spendableA = await expectSettledFromReceipt(alice, nonce)
    expect(evmWalletInternals(alice).coinList!.latestOf(main)!.valueWei).toBe(FUNDED - fee)

    // The fee goes to the other devices: the debit is the fee alone, nothing moved, no record.
    expect(await alice.flushNativeSync!()).toEqual([])
    const sent = notes.filter(items => (items[0] as WalletSyncItem).txHash === receipt.hash)
    expect(sent).toHaveLength(1)
    const note = sent[0]!
    expect(note).toHaveLength(1)
    expect(note[0]).toMatchObject({
      type: 'wallet-sync',
      direction: 'out',
      chainIdentifier: 'monad-regtest',
      txHash: receipt.hash,
      rawTx: row.members[0]!.signed!.rawTransaction,
      spentInputs: [{ address: main, nonce, valueWei: fee.toString() }],
      createdOutputs: [{ valueWei: '0' }],
    })
    expect((note[0] as WalletSyncItem).createdOutputs![0]!.address.toLowerCase()).toBe(htlc.toLowerCase())
    const member = alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!.members[0]!
    expect(member.syncApplied).toBe(true)
    // Delivered once: later flushes, re-observations and a restart send nothing again.
    await alice.flushNativeSync!()
    await alice.reobserveNativeOperations!()
    await alice.close()
    alice = await openDevice('device-a')
    expect(alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!.members[0]!.syncApplied).toBe(true)
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(notes.filter(items => (items[0] as WalletSyncItem).txHash === receipt.hash)).toHaveLength(1)
    await alice.close()

    // Device B reads the note to itself, as its inbox does.
    deviceB = await openDevice('device-b')
    try {
      expect(await consumeEvmSelfNotes(deviceB, selfNote(deviceB, note))).toMatchObject({ kind: 'consumed' })
      // The same fee on both devices, the call shown reverted...
      const notedB = (await deviceB.getNotedSends!()).find(send => send.txHash === receipt.hash.toLowerCase())
      expect(notedB?.inclusion?.feeWei).toBe(fee.toString())
      expect(notedB?.state).toBe('reverted')
      // ...and the same balance: the funded amount less exactly that fee.
      expect(await deviceB.getBalance()).toBe(fundedB - fee)
      expect(await deviceB.getSpendableBalance!()).toBe(spendableA)
      const listedB = evmWalletInternals(deviceB).coinList!.latestOf(main)
      expect(listedB).toMatchObject({ nonce: nonce + 1, valueWei: FUNDED - fee })

      // The same note again (a mailbox replay): nothing changes.
      const noted = await deviceB.getNotedSends!()
      expect(await consumeEvmSelfNotes(deviceB, selfNote(deviceB, note))).toMatchObject({ kind: 'consumed' })
      expect(await deviceB.getNotedSends!()).toEqual(noted)
      expect(await deviceB.getSpendableBalance!()).toBe(spendableA)
      expect(evmWalletInternals(deviceB).coinList!.latestOf(main)).toEqual(listedB)
    } finally {
      await deviceB.close()
      alice = await openDevice('device-a')
    }
  })

  it('a reverted call’s fee whose first delivery fails is delivered by a later flush, once', async () => {
    // The host's delivery fails the first time.
    let failNext = true
    const delivered: WalletSyncItem[] = []
    config.emitWalletSync = async (item: WalletSyncItem) => {
      if (failNext) {
        failNext = false
        throw new Error('relay unavailable')
      }
      delivered.push(item)
    }
    await alice.close()
    alice = await openDevice('device-a')
    const { row, receipt } = await lock(-60)
    expect(receipt.status).toBe(0)
    await alice.flushNativeSync!().catch(() => undefined)
    expect(alice.nativeOperationSyncFailed!(row.operationId)).toBe(true)
    // Still owed: a later flush delivers it.
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(delivered.filter(item => item.txHash === receipt.hash)).toHaveLength(1)
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(delivered.filter(item => item.txHash === receipt.hash)).toHaveLength(1)
    expect(delivered[0]!.rawTx).toBe(row.members[0]!.signed!.rawTransaction)
    expect(delivered[0]!.spentInputs).toEqual([
      {
        address: main,
        nonce: Transaction.from(row.members[0]!.signed!.rawTransaction).nonce,
        valueWei: (receipt.gasUsed * receipt.gasPrice).toString(),
      },
    ])
  })
})

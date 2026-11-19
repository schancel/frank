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
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
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
import { anvilBinary, findAnvil, nodeSuiteReady } from '../node-binaries.testutil'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})

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
/** More than any fee here: a reverted lock's note must not mistake its value for its fee. */
const LOCKED = 10n ** 17n

const anvilBin = findAnvil()
const suite = nodeSuiteReady('evm-contract-call-receipt.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

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
  async function lock(
    expiresIn: number,
    /** Runs once the call is handed out, before the wallet looks for its receipt. With it, the
     * node does not mine on its own meanwhile: `between` mines, and the host's watch then reads
     * the receipt. */
    between?: (sent: { nonce: number; txHash: string }) => Promise<void | 'stay-manual'>,
  ) {
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
    if (between) await chain.send('evm_setAutomine', [false])
    const handle = await alice.sendContractCall!({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      // Given: a call the node would revert cannot have its gas estimated.
      gasLimit: 300_000n,
      record,
    })
    if (between) {
      if ((await between({ nonce, txHash: handle.txHash })) !== 'stay-manual')
        await chain.send('evm_setAutomine', [true])
    }
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

  it('money that reaches the account while the call is out is in its next coin: the coin is what the chain holds, not the old coin less the call', async () => {
    const deposit = 3n * 10n ** 16n
    const { nonce, receipt, fee } = await lock(3600, async () => {
      // Someone pays the main account while the call is in the mempool; both are mined.
      await dev.sendTransaction({ to: main, value: deposit })
      await chain.send('evm_mine', [])
    })
    expect(receipt.status).toBe(1)
    expect(await chain.getBalance(main)).toBe(FUNDED + deposit - LOCKED - fee)
    await expectSettledFromReceipt(alice, nonce)
    expect(evmWalletInternals(alice).coinList!.latestOf(main)!.valueWei).toBe(FUNDED + deposit - LOCKED - fee)
  })

  it('a spendable read while the call is in the mempool leaves nothing for a poll once its receipt is read', async () => {
    const { nonce, receipt } = await lock(3600, async () => {
      // The balance poll runs while the call is out: the node shows it pending, the account is
      // dirty for it.
      await alice.getSpendableBalance!()
      expect(evmWalletInternals(alice).coinListSync!.isDirty(main)).toBe(true)
      await chain.send('evm_mine', [])
    })
    expect(receipt.status).toBe(1)
    await expectSettledFromReceipt(alice, nonce)
  })

  it('another device’s spend at the next nonce, told before the receipt is read, keeps that coin unselectable', async () => {
    const internals = evmWalletInternals(alice)
    let other = ''
    const { nonce } = await lock(3600, async ({ nonce }) => {
      // Device B spends the main account at the nonce after the call, and tells this device.
      const key = internals.coinList!.get(main, nonce)!.privateKey
      const signer = new Wallet(key)
      other = await signer.signTransaction({
        to: Wallet.createRandom().address,
        value: 1_000n,
        nonce: nonce + 1,
        gasLimit: 21_000n,
        gasPrice: GAS_PRICE,
        chainId: 20143n,
      })
      const spend = Transaction.from(other)
      const item: WalletSyncItem = {
        type: 'wallet-sync',
        direction: 'out',
        chainIdentifier: 'monad-regtest',
        txHash: spend.hash!,
        rawTx: other,
        spentInputs: [{ address: main, nonce: nonce + 1, valueWei: (1_000n + 21_000n * GAS_PRICE).toString() }],
        createdOutputs: [{ address: spend.to!, valueWei: '1000' }],
        timestamp: Date.now(),
      }
      expect(await consumeEvmSelfNotes(alice, selfNote(alice, [item]))).toMatchObject({ kind: 'consumed' })
      // The read the note asks for, while the call is still in the mempool.
      await internals.coinListSync!.refreshAccounts([main])
      expect(internals.coinListSync!.isDirty(main)).toBe(true)
      // The call is mined; device B's transfer reaches the node after that block and waits in its
      // mempool.
      await chain.send('evm_mine', [])
      await chain.send('eth_sendRawTransaction', [other])
      return 'stay-manual'
    })
    // The receipt is settled, but the account is not trusted: device B's transfer is still to
    // come, and the coin at the next nonce is never offered.
    expect(internals.coinList!.get(main, nonce)?.state).toBe('spent')
    expect(internals.coinListSync!.isDirty(main)).toBe(true)
    expect(await alice.transactionSetPreparer!.spendableNowWei()).toBe(0n)
    await chain.send('evm_setAutomine', [true])
    await chain.send('evm_mine', [])
    // Once mined, a read lists what the account holds after both.
    expect(await alice.getSpendableBalance!()).toBeGreaterThan(0n)
    expect(internals.coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 2, valueWei: await chain.getBalance(main) })
  })

  it('a call recorded again in another block, with more money at the account, has its next coin read again', async () => {
    const internals = evmWalletInternals(alice)
    const snapshot = await chain.send('evm_snapshot', [])
    const { nonce, row } = await lock(3600, async () => {
      await chain.send('evm_mine', [])
    })
    const raw = row.members[0]!.signed!.rawTransaction
    await expectSettledFromReceipt(alice, nonce)
    const first = internals.coinList!.latestOf(main)!.valueWei
    // A reorganisation: the block is gone, and the call lands in another, after a deposit.
    await chain.send('evm_revert', [snapshot])
    await chain.send('evm_setAutomine', [false])
    const deposit = 5n * 10n ** 16n
    await chain.send('anvil_setBalance', [main, '0x' + (FUNDED + deposit).toString(16)])
    await chain.send('evm_mine', [])
    await chain.send('eth_sendRawTransaction', [raw])
    await chain.send('evm_mine', [])
    await chain.send('evm_setAutomine', [true])
    const firstBlock = row.members[0]!.observation
    // The wallet looks at the call again (its consolidator's look at an included member, which
    // checks its block is still canonical; no balance poll) and finds it in its new block.
    const observed = () =>
      alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!
        .members[0]!.observation
    const owner = internals.nativeOperationOwner!
    const look = () =>
      (owner as unknown as {
        config: { runLifetime: <T>(body: (lifetime: never) => Promise<T>) => Promise<T> }
      }).config.runLifetime(lifetime => owner.observe(row.operationId, 0, lifetime))
    for (let i = 0; i < 4 && JSON.stringify(observed()) === JSON.stringify(firstBlock); i++)
      await look()
    for (let i = 0; i < 4 && observed().state !== 'included-success'; i++)
      await look()
    expect(observed()).toMatchObject({ state: 'included-success' })
    expect(JSON.stringify(observed())).not.toBe(JSON.stringify(firstBlock))
    expect(await chain.getBalance(main)).toBe(first + deposit)
    // The next coin listed from the first block is no longer trusted as it was: the account is
    // being read again, or has been, and selection never offers the old figure.
    const next = internals.coinList!.latestOf(main)!
    expect(internals.coinListSync!.isDirty(main) || next.valueWei === first + deposit).toBe(true)
    await internals.coinListSync!.refreshAccounts([main])
    expect(internals.coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: first + deposit })
  })

  it('a reverted call a reorganisation moves into a block with another fee: the journal, the other device and both coin lists take the new fee, the corrected note sent once', async () => {
    const sentIds: string[] = []
    config.emitWalletSync = async (item: WalletSyncItem, record: MessageItem | undefined, messageId: Uint8Array) => {
      notes.push(record ? [item, record] : [item])
      sentIds.push(Buffer.from(messageId).toString('hex'))
    }
    await alice.close()
    let deviceB = await openDevice('device-b')
    expect(await deviceB.getBalance()).toBe(FUNDED)
    await deviceB.close()
    alice = await openDevice('device-a')
    const realNow = Date.now.bind(Date)
    let offset = 0
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const poll = async () => {
      offset += 20 * 60_000
      await alice.reobserveNativeOperations!()
    }
    const note = (device: EvmChainWalletHandle, items: MessageItem[], digest: string) =>
      ({ ...selfNote(device, items), payloadDigest: digest }) as DirectMessageReceived
    // Priced while the network asks a base fee, so what the call pays depends on its block.
    const baseFee = (wei: bigint) =>
      chain.send('anvil_setNextBlockBaseFeePerGas', ['0x' + wei.toString(16)])
    await baseFee(GAS_PRICE)
    await chain.send('evm_mine', [])
    try {
      let fork = ''
      const { row, nonce, receipt: first, fee: firstFee } = await lock(-60, async () => {
        fork = await chain.send('evm_snapshot', [])
        await baseFee(0n)
        await chain.send('evm_mine', [])
      })
      expect(first.status).toBe(0)
      const raw = row.members[0]!.signed!.rawTransaction
      const call = Transaction.from(raw)
      const room = call.maxFeePerGas! - call.maxPriorityFeePerGas!
      expect(room).toBeGreaterThan(0n)
      expect(await alice.flushNativeSync!()).toEqual([])
      const firstNote = notes.find(items => (items[0] as WalletSyncItem).txHash === first.hash)!
      expect(firstNote[0]).toMatchObject({ spentInputs: [{ address: main, nonce, valueWei: firstFee.toString() }] })
      const fundedAfter = await chain.getBalance(main)
      expect(fundedAfter).toBe(FUNDED - firstFee)
      await alice.close()
      deviceB = await openDevice('device-b')
      expect(await consumeEvmSelfNotes(deviceB, note(deviceB, firstNote, 'ab'.repeat(32)))).toMatchObject({ kind: 'consumed' })
      expect((await deviceB.getNotedSends!()).find(send => send.txHash === first.hash.toLowerCase())?.inclusion?.feeWei).toBe(firstFee.toString())
      expect(await deviceB.getBalance()).toBe(FUNDED - firstFee)
      await deviceB.close()
      alice = await openDevice('device-a')

      // A reorganisation: the block is gone, and the call lands (and reverts) in another one
      // whose base fee charges it more.
      await chain.send('evm_revert', [fork])
      await chain.send('evm_setAutomine', [false])
      await baseFee(room / 2n)
      await chain.send('eth_sendRawTransaction', [raw]).catch(() => undefined)
      await chain.send('evm_mine', [])
      await chain.send('evm_setAutomine', [true])
      const moved = (await chain.getTransactionReceipt(first.hash))!
      expect(moved.status).toBe(0)
      expect(moved.blockHash).not.toBe(first.blockHash)
      const fee = moved.gasUsed * moved.gasPrice
      expect(fee).toBeGreaterThan(firstFee)
      expect(await chain.getBalance(main)).toBe(FUNDED - fee)

      // The host's polls read the recent call again (the first starts its wait) and find it
      // moved.
      await poll()
      await poll()
      // The corrected note was started by the poll; its delivery is waited for here.
      expect(await alice.flushNativeSync!()).toEqual([])
      const member = alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!.members[0]!
      expect(member.observation).toMatchObject({
        state: 'included-revert',
        blockHash: moved.blockHash.toLowerCase(),
        feeWei: fee.toString(),
      })
      expect(member.syncApplied).toBe(true)
      const sent = notes.filter(items => (items[0] as WalletSyncItem).txHash === first.hash)
      expect(sent).toHaveLength(2)
      expect(sent[1]![0]).toMatchObject({ spentInputs: [{ address: main, nonce, valueWei: fee.toString() }] })
      expect(new Set(sentIds).size).toBe(sentIds.length)
      expect(await alice.getSpendableBalance!()).toBeGreaterThan(0n)
      expect(evmWalletInternals(alice).coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: FUNDED - fee })
      // Nothing more is sent: later polls, a flush and a restart.
      await poll()
      expect(await alice.flushNativeSync!()).toEqual([])
      await alice.close()
      alice = await openDevice('device-a')
      await poll()
      expect(await alice.flushNativeSync!()).toEqual([])
      expect(notes.filter(items => (items[0] as WalletSyncItem).txHash === first.hash)).toHaveLength(2)
      await alice.close()

      deviceB = await openDevice('device-b')
      try {
        const corrected = note(deviceB, sent[1]!, 'ac'.repeat(32))
        expect(await consumeEvmSelfNotes(deviceB, corrected)).toMatchObject({ kind: 'consumed' })
        const noted = (await deviceB.getNotedSends!()).find(send => send.txHash === first.hash.toLowerCase())
        expect(noted?.inclusion).toMatchObject({ feeWei: fee.toString(), blockHash: moved.blockHash.toLowerCase() })
        expect(noted?.state).toBe('reverted')
        expect(await deviceB.getBalance()).toBe(FUNDED - fee)
        const spendableB = await deviceB.getSpendableBalance!()
        expect(evmWalletInternals(deviceB).coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: FUNDED - fee })
        // Applied twice: nothing changes.
        const record = await deviceB.getNotedSends!()
        expect(await consumeEvmSelfNotes(deviceB, corrected)).toMatchObject({ kind: 'consumed' })
        expect(await consumeEvmSelfNotes(deviceB, note(deviceB, sent[1]!, 'ad'.repeat(32)))).toMatchObject({ kind: 'consumed' })
        expect(await deviceB.getNotedSends!()).toEqual(record)
        expect(await deviceB.getSpendableBalance!()).toBe(spendableB)
        expect(evmWalletInternals(deviceB).coinList!.latestOf(main)).toMatchObject({ nonce: nonce + 1, valueWei: FUNDED - fee })
      } finally {
        await deviceB.close()
        alice = await openDevice('device-a')
      }
    } finally {
      clock.mockRestore()
      // A failed step leaves no device open behind it.
      await deviceB.close().catch(() => undefined)
    }
  })

  it('a corrected fee found while the first note is still on its way is sent once that delivery ends, and the first delivery does not mark it', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    let entered!: () => void
    const inFlight = new Promise<void>(resolve => (entered = resolve))
    let held = true
    config.emitWalletSync = async (item: WalletSyncItem) => {
      notes.push([item])
      if (held) {
        held = false
        entered()
        await gate
      }
    }
    await alice.close()
    alice = await openDevice('device-a')
    const realNow = Date.now.bind(Date)
    let offset = 0
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const poll = async () => {
      offset += 20 * 60_000
      await alice.reobserveNativeOperations!()
    }
    const baseFee = (wei: bigint) =>
      chain.send('anvil_setNextBlockBaseFeePerGas', ['0x' + wei.toString(16)])
    await baseFee(GAS_PRICE)
    await chain.send('evm_mine', [])
    try {
      let fork = ''
      const { row, nonce, receipt: first, fee: firstFee } = await lock(-60, async () => {
        fork = await chain.send('evm_snapshot', [])
        await baseFee(0n)
        await chain.send('evm_mine', [])
      })
      const raw = row.members[0]!.signed!.rawTransaction
      const call = Transaction.from(raw)
      // The first note is handed to the relay and not yet answered.
      const flushing = alice.flushNativeSync!()
      await inFlight
      await chain.send('evm_revert', [fork])
      await chain.send('evm_setAutomine', [false])
      await baseFee((call.maxFeePerGas! - call.maxPriorityFeePerGas!) / 2n)
      await chain.send('eth_sendRawTransaction', [raw]).catch(() => undefined)
      await chain.send('evm_mine', [])
      await chain.send('evm_setAutomine', [true])
      const moved = (await chain.getTransactionReceipt(first.hash))!
      const fee = moved.gasUsed * moved.gasPrice
      expect(fee).not.toBe(firstFee)
      // The polls record the new fee while the first note is still out.
      await poll()
      await poll()
      const member = () =>
        alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!.members[0]!
      expect(member().observation).toMatchObject({ feeWei: fee.toString() })
      expect(notes.filter(items => (items[0] as WalletSyncItem).txHash === first.hash)).toHaveLength(1)
      // The first delivery ends: it stated the old fee, so it marks nothing, and the corrected
      // note goes out after it.
      release()
      await flushing
      // Nothing else asks for it (no flush, no poll): the first delivery's own end sends it.
      for (let i = 0; i < 40 && !member().syncApplied; i++)
        await new Promise(resolve => setTimeout(resolve, 50))
      expect(member().syncApplied).toBe(true)
      const sent = notes.filter(items => (items[0] as WalletSyncItem).txHash === first.hash)
      expect(sent).toHaveLength(2)
      expect(sent[0]![0]).toMatchObject({ spentInputs: [{ address: main, nonce, valueWei: firstFee.toString() }] })
      expect(sent[1]![0]).toMatchObject({ spentInputs: [{ address: main, nonce, valueWei: fee.toString() }] })
      await poll()
      expect(await alice.flushNativeSync!()).toEqual([])
      expect(notes.filter(items => (items[0] as WalletSyncItem).txHash === first.hash)).toHaveLength(2)
    } finally {
      release()
      clock.mockRestore()
    }
  })

  it('a node that no longer serves an included call while its block is still canonical leaves it included', async () => {
    const realNow = Date.now.bind(Date)
    let offset = 0
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const poll = async () => {
      offset += 20 * 60_000
      await alice.reobserveNativeOperations!()
    }
    try {
      const { row, receipt } = await lock(3600)
      const recorded = row.members[0]!.observation
      expect(recorded).toMatchObject({ state: 'included-success' })
      const nonce = Transaction.from(row.members[0]!.signed!.rawTransaction).nonce
      await expectSettledFromReceipt(alice, nonce)
      // A node behind, or one that dropped the transaction from its index: no transaction, no
      // receipt, and an account read from before the call.
      const send = JsonRpcProvider.prototype.send
      const lagging = jest
        .spyOn(JsonRpcProvider.prototype, 'send')
        .mockImplementation(async function (this: JsonRpcProvider, method, params) {
          const hash = ((params as string[])[0] ?? '').toString().toLowerCase()
          if (
            (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') &&
            hash === receipt.hash.toLowerCase()
          )
            return null
          return send.call(this, method, params)
        })
      try {
        await poll()
        await poll()
        await poll()
      } finally {
        lagging.mockRestore()
      }
      const now = alice.getNativeOperations!().find(candidate => candidate.operationId === row.operationId)!.members[0]!
      expect(now.observation).toEqual(recorded)
      expect(now.syncApplied).toBe(row.members[0]!.syncApplied)
      expect(evmWalletInternals(alice).coinList!.get(main, nonce)?.state).toBe('spent')
    } finally {
      clock.mockRestore()
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

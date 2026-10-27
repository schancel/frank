/**
 * INTEGRATION: concurrent paid messages from one wallet against real chain software.
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143), the wallet's real
 * provider and HTTP client talking JSON-RPC to it, real payments from the main account and from
 * funded single-use accounts, real signing, real typed custody and Level stores, real directory admission and sealing.
 *
 * Not real, and said so: the relay. The wallet reaches the node directly instead of through the
 * relay's RPC proxy (the mock below only swaps the URL and drops the relay capability), and
 * message delivery is the wallet-level relay stand-in of `canonical-two-wallets.testutil`, which
 * here broadcasts the payments of every second message to the node (as the relay does) and of
 * the others not at all, so both broadcasters are exercised.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Transaction, Wallet, hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { LegacySendResult } from './chain-wallet'
import {
  fixture,
  mailboxes,
  offlineChain,
  roots,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import {
  LegacyTransactionSetFailedError,
  LegacyTransactionSetPendingError,
} from './evm-legacy-transaction-set'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { nativeMemberSuperseded } from '../storage/evm-native-operation-journal'
import { EVM_COIN_LIST_NAMESPACE, type StoredEvmListCoin } from '../evm-coin-list'
import { LevelRecordStore } from '../storage/evm-coin-store'
import { walletStateLocation, evmWalletStateOwner } from '../storage/wallet-state-location'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    // The wallet's own provider class, pointed at the node instead of the relay's RPC proxy.
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: mockNode.url,
        chainId: options.chainId,
      }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
// Above the fee floor of a transfer on the node (about 4e13 wei at 1.9 gwei).
const STAMP = 10n ** 15n
/** A stamp more than everything the spent sub-accounts still hold together (their successor
 * coins are listed and spendable): only the main account covers it, so it pays from main and
 * the main-account exclusivity below is exercised deliberately. */
const MAIN_STAMP = 10n ** 17n
const ID = (round: number, n: number) =>
  `00000000-0000-4000-8${round.toString(16).padStart(3, '0')}-${n
    .toString(16)
    .padStart(12, '0')}`

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: monad-parallel-send.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

suite('ten paid messages sent together on a real EVM node (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let bobMailbox: InboxRecord[]
  const relayed: Transaction[][] = []
  let relayBroadcast = 0

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    // The node charges a stable real 1 gwei price; policy still comes from its RPC.
    // This permits exact single-payment funding without residual gifts or change.
    node = spawn(
      anvilBin!,
      [
        '--port',
        String(port),
        '--chain-id',
        '10143',
        '--base-fee',
        '0',
        '--gas-price',
        '1000000000',
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, {
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

    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mailboxes.clear()
    relayed.length = 0
    relayBroadcast = 0
    f = await fixture({ transactionSetPolicy: undefined })
    alice = f.alice
    bobMailbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    const base = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(alice, {
      ...base,
      // The relay stand-in: stores the message, then (for every second message, as the real
      // relay does for all) broadcasts its payments to the node, without waiting on the result.
      fetch: async (url, init) => {
        const answer = await base.fetch!(url, init)
        const payments = restoreCanonicalRequest({
          body: new Uint8Array(init.body!),
          contentType: init.headers['Content-Type'],
        }).parts.transactions.map(raw => Transaction.from(hexlify(raw)))
        relayed.push(payments)
        if (relayed.length % 2 === 0)
          for (const tx of payments) {
            relayBroadcast++
            void chain
              .broadcastTransaction(tx.serialized)
              .catch(() => undefined)
          }
        return answer
      },
    })
  })
  afterEach(async () => {
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  const send = (round: number, n: number, stampValue = STAMP) =>
    f.chain.directMessages.send({
      wallet: alice,
      recipient: f.bob.identity.address,
      items: [{ type: 'text', text: `round ${round} message ${n}` }],
      stampValue,
      messageId: ID(round, n),
    })
  /** Ticks the wallet until every payment of `digests` is in a block. */
  async function settle(digests: string[]) {
    for (let pass = 0; pass < 200; pass++) {
      await f.chain.directMessages.reconcileAttempts({
        wallet: alice,
        payloadDigests: digests,
      })
      const states = digests.flatMap(
        digest =>
          f.chain.directMessages.paymentsOf?.({
            wallet: alice,
            payloadDigest: digest,
          }) ?? ['pending'],
      )
      if (states.every(state => state === 'spent')) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('payments did not settle')
  }
  /** What the node itself says about every payment of these sends. */
  async function onChain(sent: Awaited<ReturnType<typeof send>>[]) {
    const payments = sent.flatMap(result => result.stampPayments)
    const receipts = await Promise.all(
      payments.map(payment => chain.getTransactionReceipt(payment.txHash)),
    )
    const senders = receipts.map(receipt => receipt!.from.toLowerCase())
    return {
      payments,
      receipts,
      senders,
      senderNonces: await Promise.all(
        senders.map(sender => chain.getTransactionCount(sender, 'latest')),
      ),
      destinationBalances: await Promise.all(
        payments.map(payment => chain.getBalance(payment.destinationAddress)),
      ),
    }
  }

  it('spending root funds distributes change that pays subsequent messages without reusing the root', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    const first = await send(1, 0)
    await settle([first.payloadDigest])
    const original = alice.transactionSetPreparer!.getOperation(
      `stamp-${ID(1, 0).replace(/-/g, '')}`,
    )!
    const changes = original.members.filter(
      member => member.transactionSet?.role === 'change',
    )
    expect(changes.length).toBeGreaterThan(0)
    for (const member of changes)
      expect(
        (await chain.getTransactionReceipt(member.signed!.transactionHash))
          ?.status,
      ).toBe(1)
    const rootNonce = await chain.getTransactionCount(main, 'latest')
    const later = await send(1, 1)
    await settle([later.payloadDigest])
    const seen = await onChain([first, later])
    expect(seen.receipts.every(receipt => receipt?.status === 1)).toBe(true)
    expect(seen.senders[0]).toBe(main.toLowerCase())
    expect(
      seen.senders
        .slice(first.stampPayments.length)
        .every(account => account !== main.toLowerCase()),
    ).toBe(true)
    expect(await chain.getTransactionCount(main, 'latest')).toBe(rootNonce)
    expect(bobMailbox).toHaveLength(2)
    const originalBytes = original.members.map(
      member => member.signed!.rawTransaction,
    )
    await settle([first.payloadDigest, later.payloadDigest])
    expect(
      alice
        .transactionSetPreparer!.getOperation(
          `stamp-${ID(1, 0).replace(/-/g, '')}`,
        )!
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(originalBytes)
  })

  it('ten externally funded accounts pay independent messages concurrently on the real node', async () => {
    // Ten single-use accounts, funded from outside the wallet's main account, one stamp each.
    // Each keeps back more than any fee the wallet may quote (its quote is a few seconds old).
    const reserve = 21_000n * (await chain.getFeeData()).gasPrice!
    const before = alice.pool.records().length
    const rows = alice.pool.ensureSize(before + 10).slice(before)
    await alice.pool.flush()
    let nonce = await chain.getTransactionCount(dev.address, 'latest')
    await Promise.all(
      (
        await Promise.all(
          rows.map(row =>
            dev.sendTransaction({
              to: row.address,
              value: STAMP + reserve,
              nonce: nonce++,
            }),
          ),
        )
      ).map(tx => tx.wait()),
    )
    const main = (await alice.getReceiveAddress()).raw
    const mainNonce = await chain.getTransactionCount(main, 'latest')

    const startOne = Date.now()
    const one = await send(2, 100)
    const oneMs = Date.now() - startOne
    const start = Date.now()
    const sent = await Promise.all(
      Array.from({ length: 9 }, (_, n) => send(2, n)),
    )
    const nineMs = Date.now() - start
    const all = [one, ...sent]
    await settle(all.map(result => result.payloadDigest))
    const seen = await onChain(all)

    expect(seen.receipts.every(receipt => receipt?.status === 1)).toBe(true)
    expect(new Set(seen.senders)).toEqual(
      new Set(rows.map(row => row.address.toLowerCase())),
    )
    expect(seen.senderNonces.every(nonce => nonce === 1)).toBe(true)
    seen.payments.forEach((payment, i) =>
      expect(seen.destinationBalances[i]).toBe(payment.valueWei),
    )
    // Nothing was funded: the main account did not move.
    expect(all.flatMap(result => result.preparationTxHashes)).toEqual([])
    expect(await chain.getTransactionCount(main, 'latest')).toBe(mainNonce)
    expect(bobMailbox).toHaveLength(10)
    for (const row of rows) {
      expect(
        evmWalletInternals(alice)
          .coinList!.all()
          .find(
            coin =>
              coin.account === row.address.toLowerCase() && coin.nonce === 0,
          )?.state,
      ).toBe('spent')
      expect(await chain.getBalance(row.address)).toBe(0n)
    }
    // eslint-disable-next-line no-console
    console.log(
      `anvil independently funded sources: one send ${oneMs} ms; nine together ${nineMs} ms`,
    )
    // Sealing and signing are CPU work on one thread (about 0.1 to 0.2 s a message here), so
    // nine together are not as fast as one; the bound only catches a return to one-at-a-time
    // network waits. The wallet-level suite shows all requests in flight at once.
    expect(nineMs).toBeLessThan(9 * Math.max(oneMs, 500))
  })

  // From here the node mines only when told to, so "not mined yet" lasts as long as a test needs.
  const automine = (on: boolean) => chain.send('evm_setAutomine', [on])
  const mine = () => chain.send('evm_mine', [])
  const NATIVE_HOLDER = /:main-account$/

  it('a pending stamp reserves its shared graph; a later legacy payment spends distributed change with original bytes', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await automine(false)
    try {
      const first = await send(3, 0, MAIN_STAMP)
      const id = `stamp-${ID(3, 0).replace(/-/g, '')}`
      const original = alice.transactionSetPreparer!.getOperation(id)!
      const originalBytes = original.members.map(
        member => member.signed!.rawTransaction,
      )
      expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
      expect(
        evmWalletInternals(alice).coinList!.heldBy(id).length,
      ).toBeGreaterThan(0)
      const pendingNonce = await chain.getTransactionCount(main, 'pending')
      const recipient = Wallet.createRandom().address
      const onSigned = jest.fn()
      await expect(
        alice.sendLegacy!({
          recipient: { raw: recipient },
          // At the payment floor, so only the reserved inputs can refuse it.
          value: alice.transactionSetPreparer!.transactionSetPolicy().dustWei,
          onSigned,
        }),
      ).rejects.toThrow(/Insufficient available EVM coins/)
      expect(onSigned).not.toHaveBeenCalled()
      expect(await chain.getTransactionCount(main, 'pending')).toBe(
        pendingNonce,
      )
      expect(await chain.getBalance(recipient)).toBe(0n)
      expect(
        alice
          .transactionSetPreparer!.getOperation(id)!
          .members.map(member => member.signed!.rawTransaction),
      ).toEqual(originalBytes)

      await mine()
      await automine(true)
      await settle([first.payloadDigest])
      const rootNonce = await chain.getTransactionCount(main, 'latest')
      // At the payment floor: a Send below it is refused.
      const amount = alice.transactionSetPreparer!.transactionSetPolicy().dustWei
      const transfer = await alice.sendLegacy!({
        recipient: { raw: recipient },
        value: amount,
        onSigned,
      })
      expect(onSigned).toHaveBeenCalledTimes(1)
      expect((await chain.getTransactionReceipt(transfer.txHash))!.status).toBe(
        1,
      )
      const mined = (await chain.getTransaction(transfer.txHash))!
      expect(mined.from.toLowerCase()).not.toBe(main.toLowerCase())
      const policy = alice.transactionSetPreparer!.transactionSetPolicy()
      expect(mined.value).toBeGreaterThanOrEqual(amount)
      expect(mined.value - amount).toBeLessThan(
        policy.dustWei + policy.changeGasLimit * policy.gasPriceWei,
      )
      expect(await chain.getBalance(recipient)).toBe(mined.value)
      expect(await chain.getTransactionCount(main, 'latest')).toBe(rootNonce)
      const row = alice.getNativeOperations!().find(row =>
        row.members.some(
          member => member.signed?.transactionHash === transfer.txHash,
        ),
      )!
      expect(row.kind).toBe('transaction-set')
      expect(
        row.members.find(member => member.transactionSet?.role === 'payment')!
          .transactionSet!.intendedValueWei,
      ).toBe(amount.toString())
      const signed = row.members.map(member => member.signed!.rawTransaction)
      await alice.transactionSetSubmission!.reconcileAuthorized()
      expect(
        alice.getNativeOperations!()
          .find(candidate => candidate.operationId === row.operationId)!
          .members.map(member => member.signed!.rawTransaction),
      ).toEqual(signed)
      expect(await chain.getBalance(recipient)).toBe(mined.value)
    } finally {
      await automine(true)
    }
  })

  it('a transfer refuses reserved coin-list inputs without signing or waiting for a wallet-wide turn', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await automine(false)
    try {
      const message = await send(4, 0, MAIN_STAMP)
      const before = alice.getNativeOperations!()
      const nonce = await chain.getTransactionCount(main, 'pending')
      const onSigned = jest.fn()
      await expect(
        alice.sendLegacy!({
          recipient: { raw: Wallet.createRandom().address },
          // At the payment floor, so only the reserved inputs can refuse it.
          value: alice.transactionSetPreparer!.transactionSetPolicy().dustWei,
          mainAccountWaitMs: 1_500,
          onSigned,
        }),
      ).rejects.toThrow(/Insufficient available EVM coins/)
      expect(onSigned).not.toHaveBeenCalled()
      expect(alice.getNativeOperations!()).toEqual(before)
      expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce)
      await mine()
      await automine(true)
      await settle([message.payloadDigest])
    } finally {
      await automine(true)
    }
  })

  it('a pending contract call excludes its source from stamps; an unexposed rejected call releases its own reservation', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    const nonce = await chain.getTransactionCount(main, 'latest')
    const target = Wallet.createRandom().address
    await automine(false)
    try {
      const call = await alice.sendContractCall!({
        to: { raw: target },
        data: '0x1234',
        value: 7n,
        gasLimit: 60_000n,
      })
      expect(alice.pool.accountClaimedBy(main)).toMatch(NATIVE_HOLDER)
      const original = alice.getNativeOperations!()
      await expect(send(5, 0, MAIN_STAMP)).rejects.toThrow(
        /No funds cover a stamp/,
      )
      expect(alice.getNativeOperations!()).toEqual(original)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 1)
      await mine()
      await automine(true)
      expect((await chain.getTransactionReceipt(call.txHash))!.status).toBe(1)
      expect(await chain.getBalance(target)).toBe(7n)
      await alice.reobserveNativeOperations!()
      // Exercise this main-account call's prebroadcast cancellation before a stamp drains it.
      const before = alice.getNativeOperations!()
      await expect(
        alice.sendContractCall!({
          to: { raw: target },
          data: '0x1234',
          value: 7n,
          gasLimit: 60_000n,
          onSigned: async () => {
            throw new Error('the caller could not record it')
          },
        }),
      ).rejects.toThrow('the caller could not record it')
      const discarded = alice.getNativeOperations!().filter(
        row => !before.some(prior => prior.operationId === row.operationId),
      )
      expect(discarded).toHaveLength(1)
      expect(discarded[0]!.cancelled).toBe(true)
      expect(
        discarded[0]!.members.every(
          member => !member.signed && !member.exposed,
        ),
      ).toBe(true)
      expect(await chain.getBalance(target)).toBe(7n)
      expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 1)
      expect(alice.pool.accountClaimedBy(main)).toBeUndefined()
      const sent = await send(5, 1, MAIN_STAMP)
      await settle([sent.payloadDigest])
      const after = await send(5, 2, MAIN_STAMP)
      await settle([after.payloadDigest])
      expect(
        (await onChain([sent, after])).receipts.every(
          receipt => receipt?.status === 1,
        ),
      ).toBe(true)
    } finally {
      await automine(true)
    }
  })

  it('a transfer a host signs itself with the identity key goes through the claim: held until mined, and the next one waits', async () => {
    const identity = alice.identity.address.raw
    const signer = new Wallet(alice.identity.toPrivateKeyHex(), chain)
    const to = Wallet.createRandom().address
    await (
      await dev.sendTransaction({ to: identity, value: 10n ** 17n })
    ).wait()
    const own = () =>
      alice.runOwnTransfer!(
        async () => {
          // A fresh reader: the suite's provider may answer a count from its short cache.
          const reader = new JsonRpcProvider(mockNode.url, 10143, {
            staticNetwork: true,
            cacheTimeout: -1,
          })
          const nonce = await reader.getTransactionCount(identity, 'pending')
          reader.destroy()
          const tx = await signer.sendTransaction({ to, value: 9n, nonce })
          return { txHash: tx.hash, from: identity, nonce }
        },
        { mainAccountWaitMs: 1_500 },
      )
    await automine(false)
    try {
      const first = await own()
      expect(alice.pool.accountClaimedBy(identity)).toMatch(NATIVE_HOLDER)
      // Not mined: a second transfer does not sign behind it.
      await expect(own()).rejects.toThrow(/account needed by this operation is reserved/)
      expect(await chain.getTransactionCount(identity, 'pending')).toBe(
        first.nonce + 1,
      )
      await mine()
      const second = await own()
      expect(second.nonce).toBe(first.nonce + 1)
      await mine()
      expect(await chain.getBalance(to)).toBe(18n)
    } finally {
      await automine(true)
    }
  })

  // Send to an address (Send MONR) draws on the same coin list, selection and reservations as
  // stamps and contact payments.
  const coinAccounts = () => [
    ...new Set(
      evmWalletInternals(alice)
        .coinList!.all()
        .map(coin => coin.account.toLowerCase()),
    ),
  ]
  const balances = async (accounts: readonly string[]) =>
    (await Promise.all(accounts.map(account => chain.getBalance(account)))).reduce(
      (sum, value) => sum + value,
      0n,
    )
  const signedMembers = (operationId: string) =>
    alice
      .getNativeOperations!()
      .find(row => row.operationId === operationId)!
      .members.map(member => member.signed!.rawTransaction)
  /** A transfer with a fan-in returns pending while its members land; the app's reconciler
   * then finishes the same operation. This does the same, ticking until it is included. */
  async function finished(transfer: Promise<LegacySendResult>) {
    let operationId: string
    try {
      return await transfer
    } catch (error) {
      if (!(error instanceof LegacyTransactionSetPendingError)) throw error
      operationId = error.operation.operationId
    }
    for (let pass = 0; pass < 200; pass++) {
      try {
        return await alice.resumeLegacySend!(operationId)
      } catch (error) {
        if (!(error instanceof LegacyTransactionSetPendingError)) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    throw new Error('transfer did not settle')
  }
  const spentInputs = (raws: readonly string[]) =>
    raws.map(raw => {
      const tx = Transaction.from(raw)
      return `${tx.from!.toLowerCase()}:${tx.nonce}`
    })

  it('Send max after paid messages spends their change coins and leaves only dust that cannot pay its own gas', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    for (const n of [0, 1]) {
      const message = await send(6, n)
      await settle([message.payloadDigest])
    }
    const change = evmWalletInternals(alice)
      .coinList!.all()
      .filter(
        coin =>
          coin.origin === 'change' &&
          coin.state === 'unspent' &&
          coin.valueWei > 0n,
      )
    expect(change.length).toBeGreaterThan(0)
    const accounts = coinAccounts()
    const before = await balances(accounts)
    const recipient = Wallet.createRandom().address
    const max = await alice.estimateLegacyMax!({ recipient: { raw: recipient } })
    const result = await finished(
      alice.sendLegacy!({
        recipient: { raw: recipient },
        value: max.value,
        maxFee: max.totalFee,
      }),
    )
    expect(await chain.getBalance(recipient)).toBe(max.value)
    const mined = await Promise.all(
      [result.txHash, ...(result.intermediateTxHashes ?? [])].map(hash =>
        chain.getTransaction(hash),
      ),
    )
    const senders = new Set(mined.map(tx => tx!.from.toLowerCase()))
    // Every change coin the messages left behind went into the transfer.
    for (const coin of change)
      expect(senders.has(coin.account.toLowerCase())).toBe(true)
    // The wallet paid the quoted fee, no more, and kept nothing it could still spend.
    const after = await balances([...new Set([...accounts, ...coinAccounts()])])
    expect(before - after).toBe(max.value + max.totalFee)
    const transferFee = 21_000n * (await chain.getFeeData()).gasPrice!
    for (const account of coinAccounts())
      // Anything left on an account is less than the gas of the transaction that would move
      // it, so no transaction can spend it.
      expect(await chain.getBalance(account)).toBeLessThan(transferFee)
  })

  it('a Send and a paid message started together reserve different coins and both land', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    const first = await send(7, 0)
    await settle([first.payloadDigest])
    const recipient = Wallet.createRandom().address
    const value = 3n * STAMP
    await automine(false)
    let legacyHash: string | undefined
    try {
      const transfer = finished(
        alice.sendLegacy!({
          recipient: { raw: recipient },
          value,
          onSigned: async ({ txHash }) => {
            legacyHash = txHash
          },
        }),
      )
      const message = await send(7, 1)
      for (let pass = 0; pass < 200 && !legacyHash; pass++)
        await new Promise(resolve => setTimeout(resolve, 25))
      expect(legacyHash).toBeDefined()
      const legacyRow = alice.getNativeOperations!().find(row =>
        row.members.some(
          member => member.signed?.transactionHash === legacyHash,
        ),
      )!
      const stampRow = alice.getNativeOperations!().find(
        row =>
          row.preparationId?.endsWith(`stamp-${ID(7, 1).replace(/-/g, '')}`),
      )!
      const transferInputs = spentInputs(signedMembers(legacyRow.operationId))
      const messageInputs = spentInputs(signedMembers(stampRow.operationId))
      expect(transferInputs.filter(input => messageInputs.includes(input))).toEqual([])
      await automine(true)
      await mine()
      const result = await transfer
      await settle([message.payloadDigest])
      expect((await chain.getTransactionReceipt(result.txHash))!.status).toBe(1)
      expect(await chain.getBalance(recipient)).toBe(value)
      expect(
        (await onChain([message])).receipts.every(receipt => receipt?.status === 1),
      ).toBe(true)
    } finally {
      await automine(true)
    }
  })

  it('a Send interrupted after signing is finished by the same operation after a restart', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    const message = await send(8, 0)
    await settle([message.payloadDigest])
    const recipient = Wallet.createRandom().address
    const value = 2n * STAMP
    await automine(false)
    try {
      const interrupted = await alice
        .sendLegacy!({
          recipient: { raw: recipient },
          value,
          onSigned: async () => {
            throw new Error('the app stopped here')
          },
        })
        .catch((error: unknown) => error)
      expect(interrupted).toBeInstanceOf(LegacyTransactionSetPendingError)
      const [pending] = alice.getUnresolvedLegacySend!()
      expect(pending).toBeDefined()
      const originalBytes = signedMembers(pending!.operationId)
      await alice.close()
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      expect(alice.getUnresolvedLegacySend!().map(row => row.operationId)).toEqual([
        pending!.operationId,
      ])
      await automine(true)
      const result = await finished(alice.resumeLegacySend!(pending!.operationId))
      expect(result.txHash).toBe(
        (interrupted as LegacyTransactionSetPendingError).transaction.txHash,
      )
      expect(await chain.getBalance(recipient)).toBe(value)
      expect(
        (await alice.readNativeOperation!(pending!.operationId))!.members.map(
          member => member.signed!.rawTransaction,
        ),
      ).toEqual(originalBytes)
      // Resuming again pays nothing more.
      expect((await alice.resumeLegacySend!(pending!.operationId)).txHash).toBe(
        result.txHash,
      )
      expect(await chain.getBalance(recipient)).toBe(value)
    } finally {
      await automine(true)
    }
  })

  // Swap funding (#1884 follow-up): what a contract call from the main account needs is moved
  // into it over the one coin list, by the same transaction-set path a Send takes. monad-regtest
  // has no swap configured, so this node is where the funding is exercised on real chain software.
  it('swap funding moves the other coins into the main account on the real node; the main account signs nothing', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    // Paid messages spend the root and leave the money in change coins on other accounts.
    for (const n of [0, 1]) {
      const message = await send(9, n)
      await settle([message.payloadDigest])
    }
    const before = await alice.getContractCallFunds!()
    expect(before.otherBalance).toBeGreaterThan(0n)
    const mainBefore = await chain.getBalance(main)
    const mainNonce = await chain.getTransactionCount(main, 'latest')
    const value = before.otherBalance
    const result = await finished(alice.fundMainAccount!({ value }))
    expect(result.totalValueSent).toBe(value)
    expect(await chain.getBalance(main)).toBe(mainBefore + value)
    // The main account's own coin was never an input.
    expect(await chain.getTransactionCount(main, 'latest')).toBe(mainNonce)
    const operation = alice
      .getNativeOperations!()
      .find(row => row.members.some(member => member.signed?.transactionHash === result.txHash))!
    expect(operation.kind).toBe('transaction-set')
    expect(operation.members.every(member => member.source.address !== main.toLowerCase())).toBe(true)
    for (const member of operation.members)
      expect((await chain.getTransactionReceipt(member.signed!.transactionHash))!.status).toBe(1)
    // What the wallet now reports agrees with the node: main holds it, nothing else can move.
    const after = await alice.getContractCallFunds!()
    expect(after.mainBalance).toBe(await chain.getBalance(main))
    expect(after.otherBalance).toBe(0n)
    await expect(alice.fundMainAccount!({ value: 1n })).rejects.toThrow(/Insufficient available EVM coins/)
    expect(await chain.getBalance(main)).toBe(mainBefore + value)
  })

  it('swap funding interrupted after signing is finished by the same operation after a restart, and pays main once', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    const message = await send(10, 0)
    await settle([message.payloadDigest])
    const { otherBalance } = await alice.getContractCallFunds!()
    const value = otherBalance / 2n
    const mainBefore = await chain.getBalance(main)
    await automine(false)
    try {
      const interrupted = await alice
        .fundMainAccount!({
          value,
          onSigned: async () => {
            throw new Error('the app stopped here')
          },
        })
        .catch((error: unknown) => error)
      expect(interrupted).toBeInstanceOf(LegacyTransactionSetPendingError)
      const [pending] = alice.getUnresolvedLegacySend!()
      const originalBytes = signedMembers(pending!.operationId)
      await alice.close()
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      expect(alice.getUnresolvedLegacySend!().map(row => row.operationId)).toEqual([
        pending!.operationId,
      ])
      await automine(true)
      const result = await finished(alice.resumeLegacySend!(pending!.operationId))
      expect(result.totalValueSent).toBe(value)
      expect(await chain.getBalance(main)).toBe(mainBefore + value)
      expect(
        (await alice.readNativeOperation!(pending!.operationId))!.members.map(
          member => member.signed!.rawTransaction,
        ),
      ).toEqual(originalBytes)
      // Resuming again pays nothing more.
      await alice.resumeLegacySend!(pending!.operationId)
      expect(await chain.getBalance(main)).toBe(mainBefore + value)
    } finally {
      await automine(true)
    }
  })

  // A received-coin sweep is a transaction set over the coin list too: each stamp coin moves
  // whole to the main account, and asking again moves nothing more.
  it('received stamps are swept whole to the main account on the real node, and a second sweep moves nothing', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    const bob = f.bob
    installCanonicalDirectory(bob, await f.directoryFor('bob', bob, alice))
    const digests: string[] = []
    for (const n of [0, 1]) {
      const message = await send(12, n)
      await settle([message.payloadDigest])
      digests.push(message.payloadDigest)
    }
    await f.chain.directMessages.fetchSince({ wallet: bob, sinceMs: 0 })
    let stamps = bob.getReceivedPayments!().filter(coin => coin.origin === 'stamp')
    for (let pass = 0; pass < 200; pass++) {
      stamps = (await bob.refreshReceivedPayments!()).filter(coin => coin.origin === 'stamp')
      if (stamps.length > 0 && stamps.every(coin => coin.status !== 'pending')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(new Set(stamps.map(coin => coin.payloadDigest?.replace(/^0x/, '')))).toEqual(
      new Set(digests.map(digest => digest.replace(/^0x/, '').toLowerCase())),
    )
    const bobMain = (await bob.getReceiveAddress()).raw
    const held = async () => {
      let total = 0n
      for (const coin of stamps) total += await chain.getBalance(coin.address)
      return total
    }
    const heldBefore = await held()
    expect(heldBefore).toBe(2n * STAMP)
    const mainBefore = await chain.getBalance(bobMain)
    const answers = await bob.sweepReceivedCoins!({ payloadDigests: digests })
    for (const digest of digests) expect(answers[digest]!.outcome).toBe('swept')
    const operation = bob
      .getNativeOperations!()
      .find(row => row.kind === 'transaction-set' && row.recipient === bobMain.toLowerCase())!
    expect(operation.members).toHaveLength(stamps.length)
    const gasPrice = 10n ** 9n
    for (const member of operation.members) {
      const receipt = (await chain.getTransactionReceipt(member.signed!.transactionHash))!
      expect(receipt.status).toBe(1)
      expect(receipt.to!.toLowerCase()).toBe(bobMain.toLowerCase())
    }
    // Whole coins: every stamp account is empty, and main gained all of it less one fee each.
    expect(await held()).toBe(0n)
    expect(await chain.getBalance(bobMain)).toBe(
      mainBefore + heldBefore - BigInt(stamps.length) * 21_000n * gasPrice,
    )
    // Asked again: the coins are already swept, nothing is signed and nothing moves.
    const again = await bob.sweepReceivedCoins!({ payloadDigests: digests })
    for (const digest of digests) expect(['swept', 'none']).toContain(again[digest]!.outcome)
    expect(
      bob.getNativeOperations!().filter(row => row.kind === 'transaction-set' && row.recipient === bobMain.toLowerCase()),
    ).toHaveLength(1)
    expect(await chain.getBalance(bobMain)).toBe(
      mainBefore + heldBefore - BigInt(stamps.length) * 21_000n * gasPrice,
    )
  })
  // A free coin the lab wallets were left with: the consolidation account's nonce-0 coin listed
  // `unspent` beside the coins after it, although the Send that spent it is mined and retired.
  // The quote counted it (Send max offered more than the wallet held) and Confirm signed it
  // again, which the journal refused (its nonce is recorded consumed). An account has one live
  // coin, and the chain is past that nonce: it is never offered, and the next read drops it.
  it('a free coin left at a nonce the chain has passed is never quoted or spent; Send max sends what the chain holds', async () => {
    // Completed operations leave the active journal once their self-sync note is written.
    await alice.close()
    await f.close()
    f = await fixture({ transactionSetPolicy: undefined, emitWalletSync: async () => undefined })
    alice = f.alice
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 5n * 10n ** 16n })).wait()
    await (await dev.sendTransaction({ to: alice.identity.address.raw, value: 5n * 10n ** 16n })).wait()
    // More than either account holds: both are gathered into a fresh account, which pays.
    const transfer = await finished(
      alice.sendLegacy!({ recipient: { raw: Wallet.createRandom().address }, value: 6n * 10n ** 16n }),
    )
    for (let pass = 0; pass < 20 && alice.getNativeOperations!().length; pass++) {
      await alice.flushNativeSync!()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(alice.getNativeOperations!()).toEqual([])
    // The account the coins were gathered into, and its first coin, spent by the transfer.
    const payer = (await chain.getTransaction(transfer.txHash))!.from.toLowerCase()
    const first = evmWalletInternals(alice).coinList!.get(payer, 0)!
    expect(first.state).toBe('spent')
    expect(await chain.getTransactionCount(payer)).toBeGreaterThan(0)
    // The record as the lab wallets had it: the same coin, free, no holder and no transaction.
    await alice.close()
    const location = walletStateLocation({
      base: join(f.root, 'wallet'),
      chainIdentifier: 'monad-testnet',
      owner: evmWalletStateOwner(main),
    })
    const store = await LevelRecordStore.open<StoredEvmListCoin>(location, EVM_COIN_LIST_NAMESPACE)
    await store.put(`${payer}:0`, {
      account: payer,
      nonce: 0,
      privateKey: first.privateKey,
      valueWei: first.valueWei.toString(),
      origin: first.origin,
      ...(first.changeIndex === undefined ? {} : { changeIndex: first.changeIndex }),
      state: 'unspent',
    })
    await store.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    const recipient = Wallet.createRandom().address
    const held = await balances(coinAccounts())
    const max = await alice.estimateLegacyMax!({ recipient: { raw: recipient } })
    // What the quote offers is what the chain holds, less the fees: not the stale coin too.
    expect(max.value + max.totalFee).toBe(held)
    expect(evmWalletInternals(alice).coinList!.get(payer, 0)?.state).not.toBe('unspent')
    const result = await finished(
      alice.sendLegacy!({ recipient: { raw: recipient }, value: max.value, maxFee: max.totalFee }),
    )
    expect((await chain.getTransactionReceipt(result.txHash))!.status).toBe(1)
    expect(await chain.getBalance(recipient)).toBe(max.value)
  })

  // The lab wallets' stuck Send: transactions the node no longer knows, every account's
  // nonce past them, and two change transfers from the paying account never sent because each
  // waited for its predecessor's receipt. "Being offered again" for ever, its change held. The
  // chain showing the predecessor's nonce consumed is what the next nonce needs: the original
  // change transfers are sent, and the operation ends.
  describe('under Monad spend spacing', () => {
    beforeEach(async () => {
      await alice.close()
      await f.close()
      f = await fixture({
        transactionSetPolicy: undefined,
        spendSpacingBlocks: 3,
        reserveBalanceWei: 10n ** 18n,
      })
      alice = f.alice
    })

    it('a Send whose payment nonce the chain shows consumed sends its waiting change and ends; nothing stays held', async () => {
      const main = (await alice.getReceiveAddress()).raw
      const identity = alice.identity.address.raw
      await (await dev.sendTransaction({ to: main, value: 5n * 10n ** 16n })).wait()
      await (await dev.sendTransaction({ to: identity, value: 5n * 10n ** 16n })).wait()
      for (let i = 0; i < 5; i++) await mine()
      const recipient = Wallet.createRandom().address
      const value = 6n * 10n ** 16n
      // More than either coin holds: both are gathered into a fresh account, which pays, then
      // sends its residual to change accounts, each change transfer after the one before it.
      const started = await alice
        .sendLegacy!({ recipient: { raw: recipient }, value })
        .catch((error: unknown) => error)
      expect(started).toBeInstanceOf(LegacyTransactionSetPendingError)
      const operationId = (started as LegacyTransactionSetPendingError).operation.operationId
      const row = async () => (await alice.readNativeOperation!(operationId))!
      const first = await row()
      const payment = first.members.find(m => m.transactionSet?.role === 'payment')!
      const payer = payment.source.address.toLowerCase()
      const changes = first.members.filter(
        m => m.transactionSet?.role === 'change' && m.source.address.toLowerCase() === payer,
      )
      expect(changes.length).toBeGreaterThan(0)
      expect(changes.every(m => m.transactionSet?.predecessorWaitBlocks !== undefined)).toBe(true)
      // The payment goes out once its funding has matured. The node then loses it and the
      // account's nonce 0 is taken anyway: what a node that has pruned the mined payment shows
      // (the nonce consumed, the wallet's transaction unknown). Here the same transfer signed
      // again at one wei more per gas, its value lowered by that much: the account ends where
      // the payment would have left it, which is what the change after it was signed against.
      const key = evmWalletInternals(alice).coinList!.get(payer, 0)!.privateKey
      await automine(false)
      for (let pass = 0; pass < 40 && !(await row()).members.find(m => m.transactionSet?.role === 'payment')!.exposed; pass++) {
        await mine()
        await alice.resumeLegacySend!(operationId).catch(() => undefined)
      }
      expect((await row()).members.find(m => m.transactionSet?.role === 'payment')!.exposed).toBe(true)
      await chain.send('anvil_dropTransaction', [payment.signed!.transactionHash])
      const planned = Transaction.from(payment.signed!.rawTransaction)
      const price = (planned.gasPrice ?? planned.maxFeePerGas)!
      const foreign = await new Wallet(key, chain).sendTransaction({
        type: 0,
        to: planned.to!,
        value: planned.value - planned.gasLimit,
        nonce: 0,
        gasLimit: planned.gasLimit,
        gasPrice: price + 1n,
      })
      await mine()
      await automine(true)
      expect((await chain.getTransactionReceipt(foreign.hash))?.status).toBe(1)
      expect(await chain.getTransaction(payment.signed!.transactionHash)).toBeNull()
      let outcome: unknown
      let final = await row()
      for (let pass = 0; pass < 60; pass++) {
        await mine()
        outcome = await alice.resumeLegacySend!(operationId).catch((error: unknown) => error)
        final = await row()
        if (
          final.members.every(
            m => m.observation.state === 'included-success' || nativeMemberSuperseded(m),
          ) &&
          !alice.getNativeOperations!().some(r => r.operationId === operationId && r.members.some(m => !m.transactionSet?.inventoryApplied))
        )
          break
      }
      // The payment is final (its nonce taken), and its change went out with the original bytes.
      expect(outcome).toBeInstanceOf(LegacyTransactionSetFailedError)
      expect(nativeMemberSuperseded(final.members.find(m => m.transactionSet?.role === 'payment')!)).toBe(true)
      for (const change of changes) {
        const receipt = await chain.getTransactionReceipt(change.signed!.transactionHash)
        expect(receipt?.status).toBe(1)
      }
      expect(summarizeEvmNativeOperation(final).payment).toBe('superseded')
      // Nothing the operation reserved is held any more.
      expect(
        evmWalletInternals(alice)
          .coinList!.all()
          .filter(c => c.state === 'pending_receipt' || c.state === 'spend_pending'),
      ).toEqual([])
      // What the paying account had left is in the wallet's change accounts, spendable.
      for (let i = 0; i < 5; i++) await mine()
      const max = await alice.estimateLegacyMax!({ recipient: { raw: recipient } })
      expect(max.value + max.totalFee).toBe(await balances(coinAccounts()))
    })
  })
})

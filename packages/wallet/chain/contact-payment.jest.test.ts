/**
 * A payment to a contact and the coin it becomes, at the wallet's own seams.
 *
 * UNIT tests: real typed custody, real Level stores and journals, real directory admission, real
 * sealing and opening. The node behind each wallet's provider and the relay's HTTP surface are
 * stubs (`canonical-two-wallets.testutil.ts` plus the provider spies below), so nothing here says
 * anything about a real chain or a real relay. The same behaviour against a real EVM node is
 * `contact-payment.anvil.integration.ts`.
 */
import { toHex } from '@frank/codec'
import {
  Transaction,
  Wallet,
  getBytes,
  type Block,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  ContactPaymentPendingError,
  ContactPaymentReleasedError,
  type ReceivedPayment,
  type ContactSendParams,
  type ContactSendResult,
} from './chain-wallet'
import {
  fixture,
  offlineChain,
  mailboxes,
  mockBalances,
  mockFunded,
  roots,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { withDefaultMessageItems } from './message-items.testutil'
import { deriveEvmStealthPrivateKey, deriveEvmStealthAddress } from '../evm-stealth'
import {
  CONTACT_PAYMENT_NAMESPACE,
  LevelRecordStore,
  type ContactPayment,
} from '../storage/evm-coin-store'
import { createEvmChain, installCanonicalDirectory } from './evm-chain'
import { MonadStampPendingAttemptError } from '../evm-stamp-client'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '../evm-transaction-set-types'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

jest.setTimeout(120_000)

const BLOCK_HASH = '0x' + '11'.repeat(32)
const FEE = 21_000n
/** The stubbed node: what was broadcast, by hash, and each account's next nonce. */
const node = {
  nonces: new Map<string, number>(),
  transactions: new Map<string, TransactionResponse>(),
  receipts: new Map<string, TransactionReceipt>(),
  broadcasts: [] as { from: string; to: string; value: bigint; hash: string }[],
  /** Wallets whose own broadcasts are refused (their node is unreachable). */
  unreachable: new Set<EvmChainWalletHandle>(),
}
function attach(wallet: EvmChainWalletHandle) {
  jest
    .spyOn(wallet.provider, 'getBlock')
    .mockResolvedValue({ hash: BLOCK_HASH, number: 1 } as Block)
  jest
    .spyOn(wallet.provider, 'getTransactionCount')
    .mockImplementation(
      async address => node.nonces.get(String(address).toLowerCase()) ?? 0,
    )
  jest.spyOn(wallet.provider, 'getFeeData').mockResolvedValue({
    gasPrice: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as never)
  jest.spyOn(wallet.provider, 'estimateGas').mockResolvedValue(21_000n)
  jest
    .spyOn(wallet.provider, 'getTransaction')
    .mockImplementation(async hash => node.transactions.get(hash) ?? null)
  jest
    .spyOn(wallet.provider, 'getTransactionReceipt')
    .mockImplementation(async hash => node.receipts.get(hash) ?? null)
  jest
    .spyOn(wallet.provider, 'broadcastTransaction')
    .mockImplementation(async raw => {
      if (node.unreachable.has(wallet)) throw new Error('node unreachable')
      const tx = Transaction.from(raw)
      const hash = tx.hash!
      if (node.transactions.has(hash)) throw new Error('already known')
      const from = tx.from!.toLowerCase()
      const to = tx.to!.toLowerCase()
      if ((node.nonces.get(from) ?? 0) !== tx.nonce)
        throw new Error('nonce too low')
      if ((mockBalances.get(from) ?? 0n) < tx.value + FEE)
        throw new Error('insufficient funds')
      node.nonces.set(from, tx.nonce + 1)
      mockBalances.set(from, (mockBalances.get(from) ?? 0n) - tx.value - FEE)
      mockBalances.set(to, (mockBalances.get(to) ?? 0n) + tx.value)
      node.broadcasts.push({ from, to, value: tx.value, hash })
      node.transactions.set(
        hash,
        Object.assign(tx, {
          blockHash: BLOCK_HASH,
          blockNumber: 1,
          index: 0,
        }) as unknown as TransactionResponse,
      )
      node.receipts.set(hash, {
        hash,
        from: tx.from,
        to: tx.to,
        blockHash: BLOCK_HASH,
        blockNumber: 1,
        index: 0,
        status: 1,
        gasPrice: 1n,
        gasUsed: 21_000n,
      } as unknown as TransactionReceipt)
      return { hash } as TransactionResponse
    })
}

const subjectOf = (wallet: EvmChainWalletHandle) =>
  toHex(wallet.identity.compressedPubKey)
const VALUE = 5_000_000n
/** What a message carries here when no stamp is named: the configured default (1,000) raised to
 * this node's fee floor, 21,000 gas at its price of 1. */
const STAMP = 21_000n

describe('a payment to a contact', () => {
  let f: Fixture
  let alice: EvmChainWalletHandle
  let bob: EvmChainWalletHandle
  let bobMailbox: InboxRecord[]
  let extraRoots: string[]
  const poll = (wallet: EvmChainWalletHandle, sinceMs = 0) =>
    f.chain.directMessages.fetchSince({ wallet, sinceMs })
  /** The wallet's stealth coins. (Every message also pays a stamp: see the stamp tests below.) */
  const coinsOf = (wallet: EvmChainWalletHandle): ReceivedPayment[] =>
    wallet.getReceivedPayments!().filter(coin => coin.origin === 'stealth')
  const stampsOf = (wallet: EvmChainWalletHandle): ReceivedPayment[] =>
    wallet.getReceivedPayments!().filter(coin => coin.origin === 'stamp')
  const byAddress = (coins: ReceivedPayment[]) =>
    [...coins].sort((a, b) => a.address.localeCompare(b.address))
  /** Reads the chain until nothing of the wallet's is pending (a broadcast is mined at once by
   * the stub, and the wallet sees the inclusion on its next read). */
  const settle = async (wallet: EvmChainWalletHandle) => {
    await wallet.refreshReceivedPayments!()
    await wallet.refreshReceivedPayments!()
    wallet.invalidateBalanceCache!()
  }
  const mainOf = async (wallet: EvmChainWalletHandle) =>
    (await wallet.getReceiveAddress()).raw.toLowerCase()
  const toOneTimeAddresses = () =>
    node.broadcasts.filter(sent => sent.value === VALUE)

  const recoverMessage = async (wallet: EvmChainWalletHandle, digest: string) => {
    for (let pass = 0; pass < 5; pass++) {
      const status = await f.chain.directMessages.reconcileAttempts({
        wallet,
        payloadDigests: [digest],
      })
      if (status[digest] === 'delivered') {
        await wallet.resumeContactPayments!()
        return
      }
    }
    throw new Error('Original message did not recover')
  }
  const digestOf = (error: ContactPaymentPendingError): string => {
    expect(error.reason).toBeInstanceOf(MonadStampPendingAttemptError)
    return (error.reason as MonadStampPendingAttemptError).payloadHashes[0]!
  }

  // Advance dependent funding/stamp waves through the host recovery entry point. Never
  // call sendToContact again: that would authorize a second payment and a second message.
  const sendContact = async (params: ContactSendParams): Promise<ContactSendResult> => {
    try {
      return await alice.sendToContact!(params)
    } catch (error) {
      if (
        !(error instanceof ContactPaymentPendingError) ||
        !(error.reason instanceof MonadStampPendingAttemptError)
      )
        throw error
      const payloadDigest = error.reason.payloadHashes[0]!
      await recoverMessage(alice, payloadDigest)
      const payment = alice.getContactPayments!().find(
        p => p.messageId === error.messageId,
      )!
      expect(['paid', 'delivered']).toContain(payment.state)
      const member = alice.getNativeOperations!()
        .flatMap(op => op.members)
        .find(member => member.signed?.transactionHash === error.txHash)!
      return {
        messageId: error.messageId,
        txHash: error.txHash!,
        stealthAddress: Transaction.from(member.signed!.rawTransaction).to!,
        value: params.value,
        payloadDigest,
      }
    }
  }

  beforeEach(async () => {
    // This suite has its own node (the stubs below): the relay stand-in must not also put
    // payments on the shared offline chain, or a payment would be credited twice.
    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    node.nonces.clear()
    node.transactions.clear()
    node.receipts.clear()
    node.broadcasts.length = 0
    node.unreachable.clear()
    extraRoots = []
    useProviderStandIns()
    // Match the provider's fee quote and keep this payment/recovery suite's graphs small.
    // Transaction-set distribution itself has separate coverage.
    f = await fixture({
      transactionSetPolicy: () => ({
        sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
        gasPriceWei: 1n,
        paymentGasLimit: () => 21000n,
        changeGasLimit: 21000n,
        paymentFeeIsExact: true,
        dustWei: 21000n,
        radix: 2,
        jitterBps: 0,
        maxChangeOutputs: 2,
        head: 100,
      }),
    })
    alice = f.alice
    bob = f.bob
    installCanonicalDirectory(alice, await f.directoryFor('alice', alice, bob))
    installCanonicalDirectory(bob, await f.directoryFor('bob', bob, alice))
    attach(alice)
    attach(bob)
    bobMailbox = []
    mailboxes.set(subjectOf(bob), bobMailbox)
    mailboxes.set(subjectOf(alice), [])
    f.setMailbox(bobMailbox)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    useProviderStandIns(false)
    await f.close().catch(() => undefined)
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true })
  })

  it('pays from the wallet main funds through a recorded operation and delivers the item', async () => {
    const aliceMain = await mainOf(alice)
    const before = mockBalances.get(aliceMain)!
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
      memo: 'lunch',
    })

    // The recipient transfer is one member of the shared, journalled payment/change graph.
    expect(toOneTimeAddresses()).toEqual([
      {
        from: aliceMain,
        to: sent.stealthAddress.toLowerCase(),
        value: VALUE,
        hash: sent.txHash,
      },
    ])
    expect(aliceMain).not.toBe(alice.identity.address.raw.toLowerCase())
    const operation = alice
      .getNativeOperations!()
      .find(row => row.recipient === sent.stealthAddress.toLowerCase())!
    const paymentMember = operation.members.find(
      member => member.signed?.transactionHash === sent.txHash,
    )!
    expect(paymentMember.transactionSet?.role).toBe('payment')
    expect(paymentMember.source.address).toBe(aliceMain)
    expect(mockBalances.get(aliceMain)!).toBeLessThanOrEqual(before - VALUE)

    // One message, in bob's mailbox, carrying the item with the signed transfer.
    expect(bobMailbox).toHaveLength(1)
    const [message] = await poll(bob)
    expect(message.payloadDigest).toBe(sent.payloadDigest)
    expect(message.messageId).toBe(sent.messageId)
    expect(message.items).toHaveLength(1)
    expect(message.items[0]).toMatchObject({
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      amount: Number(VALUE),
      memo: 'lunch',
    })
    expect(alice.getContactPayments!()).toEqual([
      expect.objectContaining({
        messageId: sent.messageId,
        state: 'paid',
        valueWei: VALUE,
        txHash: sent.txHash,
      }),
    ])
  })

  it('the contact sees it pending, then received at the chain amount, and spends it in an ordinary send', async () => {
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const oneTime = sent.stealthAddress.toLowerCase()
    const bobMain = await mainOf(bob)
    // Leave bob with nothing else to spend: only the received coin can pay.
    mockBalances.set(bobMain, 0n)

    await poll(bob)
    // Recorded, and nothing has been read from the chain: pending, worth nothing.
    expect(coinsOf(bob)).toEqual([
      expect.objectContaining({
        address: oneTime,
        origin: 'stealth',
        status: 'pending',
        amountWei: 0n,
        claimedAmountWei: VALUE,
        spendable: false,
      }),
    ])

    // The chain is read: received, at what the chain holds, and part of the balance (with the
    // message's stamp, which is a coin too).
    await settle(bob)
    expect(await bob.getBalance()).toBe(VALUE + STAMP)
    expect(coinsOf(bob)[0]).toMatchObject({
      status: 'received',
      amountWei: VALUE,
      spendable: true,
    })

    // An ordinary native send is paid from the coin, signed with its one-time key.
    const carol = '0x' + 'c0'.repeat(20)
    const spent = await bob.sendNative({ recipient: { raw: carol }, value: 1_000_000n })
    const spend = node.broadcasts.find(tx => tx.hash === spent.txHash)!
    expect(spend).toMatchObject({ from: oneTime, to: carol, value: 1_000_000n })
    expect(mockBalances.get(carol)).toBe(1_000_000n)
    bob.invalidateBalanceCache!()
    expect(await bob.getBalance()).toBe(VALUE - 1_000_000n - FEE + STAMP)
  })

  it('survives a reload: a new handle on the same storage still has the coin and its key', async () => {
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
    })
    await poll(bob)
    await settle(bob)
    const known = byAddress(bob.getReceivedPayments!())
    expect(coinsOf(bob)[0]).toMatchObject({ status: 'received', amountWei: VALUE })
    expect(stampsOf(bob)[0]).toMatchObject({ status: 'received', amountWei: STAMP })
    await bob.close()

    // The mailbox is NOT read again: the cursor of a reloaded app is past the message.
    const reloaded = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
    attach(reloaded)
    try {
      expect(byAddress(reloaded.getReceivedPayments!())).toEqual(known)
      mockBalances.set(await mainOf(reloaded), 0n)
      expect(await reloaded.getBalance()).toBe(VALUE + STAMP)
      const carol = '0x' + 'c1'.repeat(20)
      const spent = await reloaded.sendNative({
        recipient: { raw: carol },
        value: 1_000n,
      })
      expect(node.broadcasts.find(tx => tx.hash === spent.txHash)!.from).toBe(
        sent.stealthAddress.toLowerCase(),
      )
    } finally {
      await reloaded.close()
    }
  })

  it('restored on a fresh device, reading the mailbox from the start finds it; reading again adds nothing', async () => {
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
    })
    await bob.close()

    const root = mkdtempSync(join(tmpdir(), 'contact-payment-restore-'))
    extraRoots.push(root)
    const freshChain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const restored = (await freshChain.createWallet(roots(1))) as EvmChainWalletHandle
    attach(restored)
    try {
      installCanonicalDirectory(
        restored,
        await f.directoryFor('bob-restored', restored, alice),
      )
      expect(coinsOf(restored)).toEqual([])
      await freshChain.directMessages.fetchSince({ wallet: restored, sinceMs: 0 })
      await settle(restored)
      const found = coinsOf(restored)
      expect(found).toEqual([
        expect.objectContaining({
          address: sent.stealthAddress.toLowerCase(),
          status: 'received',
          amountWei: VALUE,
          spendable: true,
        }),
      ])
      const all = byAddress(restored.getReceivedPayments!())
      expect(stampsOf(restored)).toHaveLength(1)
      await freshChain.directMessages.fetchSince({ wallet: restored, sinceMs: 0 })
      expect(byAddress(restored.getReceivedPayments!())).toEqual(all)
    } finally {
      await restored.close()
    }
  })

  it('a relay failure retains the original payment and message while unrelated inputs remain usable', async () => {
    f.setPhase('fail')
    node.unreachable.add(alice)
    const refused = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
    }).catch((error) => error)
    expect(refused).toBeInstanceOf(ContactPaymentPendingError)
    const digest = digestOf(refused)
    expect(node.broadcasts).toEqual([])
    expect(bobMailbox).toHaveLength(0)
    const [saved] = alice.getContactPayments!()
    const operation = alice.getNativeOperations!().find((row) =>
      row.members.some((m) => m.signed?.transactionHash === saved.txHash),
    )!
    const signed = operation.members.map((member) => member.signed!.rawTransaction)
    await expect(
      alice.sendNative({ recipient: { raw: '0x' + 'c4'.repeat(20) }, value: 10n ** 17n }),
    ).rejects.toThrow('Insufficient unreserved native funds')
    node.unreachable.delete(alice)
    const spare = alice.pool.ensureSize(alice.pool.records().length + 1).slice(-1)[0]
    await alice.pool.flush()
    mockBalances.set(spare.address.toLowerCase(), 1_000_000n)
    const small = await alice.sendNative({
      recipient: { raw: '0x' + 'c4'.repeat(20) },
      value: 100n,
    })
    expect(node.broadcasts.find((tx) => tx.hash === small.txHash)!.from).toBe(
      spare.address.toLowerCase(),
    )
    f.setPhase('delivered')
    await recoverMessage(alice, digest)
    expect(bobMailbox).toHaveLength(1)
    expect(toOneTimeAddresses()).toEqual([
      expect.objectContaining({ hash: saved.txHash }),
    ])
    const [message] = await poll(bob)
    expect(message.messageId).toBe(saved.messageId)
    expect(message.payloadDigest).toBe(digest)
    expect(
      alice.getNativeOperations!()
        .find((row) => row.operationId === operation.operationId)!
        .members.map((member) => member.signed!.rawTransaction),
    ).toEqual(signed)
    const count = node.broadcasts.length
    await recoverMessage(alice, digest)
    expect(node.broadcasts).toHaveLength(count)
    expect(bobMailbox).toHaveLength(1)
    expect(alice.getContactPayments!()[0].state).toBe('paid')
  })

  it('the encrypted host message and signed graph are durable before the first broadcast', async () => {
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    let durable = false
    let digest: string | undefined
    const broadcast = jest.mocked(alice.provider.broadcastTransaction)
    const real = broadcast.getMockImplementation()!
    broadcast.mockImplementation(async (raw) => {
      expect(durable).toBe(true)
      return real(raw)
    })
    await f.chain.directMessages
      .send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [prepared.item],
        stampValue: prepared.stampValue,
        onBeforeExposure: (hash) => {
          durable = true
          digest = hash
        },
      })
      .catch((error) => {
        expect(error).toBeInstanceOf(MonadStampPendingAttemptError)
      })
    await recoverMessage(alice, digest!)
    expect(bobMailbox).toHaveLength(1)
    expect(toOneTimeAddresses()).toEqual([
      expect.objectContaining({ hash: prepared.txHash }),
    ])
  })

  it('a stop before confirmation recovers the captured stamp after restart with the oracle offline', async () => {
    f.setPhase('fail')
    node.unreachable.add(alice)
    const refused = await alice
      .sendToContact!({ recipient: bob.identity.address, value: VALUE })
      .catch(error => error)
    expect(refused).toBeInstanceOf(ContactPaymentPendingError)
    expect(node.broadcasts).toEqual([])
    await alice.close()

    const offline = jest.fn(async () => { throw new Error('oracle offline') })
    f.config.resolveDefaultStamp = offline

    const restarted = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    attach(restarted)
    try {
      installCanonicalDirectory(
        restarted,
        await f.directoryFor('alice-restarted', restarted, bob),
      )
      // Still held after the restart.
      expect(restarted.getContactPayments!()[0].state).toBe('prepared')
      await expect(
        restarted.sendNative({
          recipient: { raw: '0x' + 'c5'.repeat(20) },
          value: 10n ** 17n,
        }),
      ).rejects.toThrow('Insufficient unreserved native funds')
      expect(node.broadcasts).toEqual([])

      f.setPhase('delivered')
      await recoverMessage(restarted, digestOf(refused))
      // The host's ordinary mailbox read is what finishes it.
      await f.chain.directMessages.fetchSince({ wallet: restarted, sinceMs: 0 })
      await restarted.resumeContactPayments!()
      await restarted.resumeContactPayments!()
      expect(restarted.getContactPayments!()).toEqual([
        expect.objectContaining({ state: 'paid', txHash: refused.txHash }),
      ])
      expect(offline).not.toHaveBeenCalled()
      expect(bobMailbox).toHaveLength(1)
      const paid = toOneTimeAddresses()
      expect(paid).toEqual([expect.objectContaining({ hash: refused.txHash })])
      expect(
        restarted
          .getNativeOperations!()
          .filter(row => row.recipient === paid[0].to && !row.cancelled),
      ).toHaveLength(1)

      await poll(bob)
      mockBalances.set(await mainOf(bob), 0n)
      await settle(bob)
      expect(await bob.getBalance()).toBe(VALUE + STAMP)
    } finally {
      await restarted.close()
    }
  })

  it('the sender stops after the relay accepted and before its own broadcast: the contact wallet broadcasts the carried transfer and has the money', async () => {
    mockBalances.set(await mainOf(alice), VALUE + FEE)
    node.unreachable.add(alice)
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
      stampValue: 0n,
    })
    // Alice could not broadcast; the message was delivered all the same.
    expect(toOneTimeAddresses()).toHaveLength(0)
    expect(bobMailbox).toHaveLength(1)

    await poll(bob)
    mockBalances.set(await mainOf(bob), 0n)
    // Bob's wallet finds no such transfer on the chain and broadcasts the carried one itself:
    // exactly alice's signed transaction.
    await settle(bob)
    expect(toOneTimeAddresses()).toEqual([
      expect.objectContaining({
        from: await mainOf(alice),
        to: sent.stealthAddress.toLowerCase(),
        hash: sent.txHash,
      }),
    ])
    // The next read sees it included, with the money at the account.
    await settle(bob)
    expect(await bob.getBalance()).toBe(VALUE)
    expect(coinsOf(bob)[0]).toMatchObject({ status: 'received', amountWei: VALUE })
  })

  it('a host that sends the message itself: the prepared transfer is retained with the same host message through a relay failure', async () => {
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
      memo: 'lunch',
    })
    expect(prepared.stampValue).toBe(STAMP)
    // Signed, saved, held: nothing sent anywhere.
    expect(node.broadcasts).toEqual([])
    expect(bobMailbox).toHaveLength(0)
    expect(alice.getContactPayments!()).toEqual([
      expect.objectContaining({ state: 'prepared', txHash: prepared.txHash }),
    ])

    // A failed relay attempt may already have paid the contact. Retain that same operation.
    f.setPhase('fail')
    let attempt: string | undefined
    await f.chain.directMessages
      .send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [prepared.item],
        stampValue: prepared.stampValue,
        onAttemptCreated: digest => {
          attempt = digest
        },
      })
      .catch(() => undefined)
    expect(toOneTimeAddresses()).toEqual([expect.objectContaining({ hash: prepared.txHash })])
    expect(alice.getContactPayments!()[0].state).toBe('prepared')

    // Reconcile the original attempt until its message is stored; never pay a second time.
    f.setPhase('delivered')
    await recoverMessage(alice, attempt!)
    expect(bobMailbox).toHaveLength(1)
    expect(toOneTimeAddresses()).toEqual([
      expect.objectContaining({
        to: prepared.stealthAddress.toLowerCase(),
        hash: prepared.txHash,
      }),
    ])
    await alice.resumeContactPayments!()
    expect(alice.getContactPayments!()[0].state).toBe('paid')

    const [message] = await poll(bob)
    expect(message.items).toEqual([prepared.item])
    mockBalances.set(await mainOf(bob), 0n)
    await settle(bob)
    expect(await bob.getBalance()).toBe(VALUE + STAMP)
  })

  describe('a held payment is released or finished, never left holding the account', () => {
    const big = 10n ** 17n
    const held = (wallet: EvmChainWalletHandle) =>
      wallet.getContactPayments!().filter((payment) => payment.holdsFunds)
    const hostSends = (
      item: Parameters<typeof f.chain.directMessages.send>[0]['items'][0],
      extra = {},
    ) =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [item],
        messageId: '11111111-1111-4111-8111-111111111111',
        ...extra,
      })

    it('a free message (no stamp, so no payment attempt) still tells the payment it was delivered', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
        stampValue: 0n,
      })
      expect(held(alice)).toHaveLength(1)
      await hostSends(prepared.item, { stampValue: 0n })
      await alice.resumeContactPayments!()
      await alice.resumeContactPayments!()
      expect(alice.getContactPayments!()).toEqual([
        expect.objectContaining({ state: 'paid', holdsFunds: false }),
      ])
      expect(toOneTimeAddresses()).toEqual([
        expect.objectContaining({ hash: prepared.txHash }),
      ])
    })

    it('left by an earlier session with nothing ever sent: released at the first pass, its account free, its item refused', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      // The app stops here: the chat store never saved or sent the message.
      await alice.close()
      const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      attach(reopened)
      try {
        installCanonicalDirectory(
          reopened,
          await f.directoryFor('alice-reopened', reopened, bob),
        )
        expect(held(reopened)).toHaveLength(1)
        await expect(
          reopened.sendNative({ recipient: { raw: '0x' + 'c7'.repeat(20) }, value: big }),
        ).rejects.toThrow('Insufficient unreserved native funds')

        await reopened.resumeContactPayments!()
        expect(reopened.getContactPayments!()).toEqual([
          expect.objectContaining({ state: 'released', holdsFunds: false }),
        ])
        // The account is usable again, at the very nonce the cancelled transfer had.
        const aliceMain = await mainOf(reopened)
        const spent = await reopened.sendNative({
          recipient: { raw: '0x' + 'c7'.repeat(20) },
          value: big,
        })
        expect(node.broadcasts).toEqual([
          expect.objectContaining({ from: aliceMain, hash: spent.txHash, value: big }),
        ])
        // A message carrying the released payment's item never leaves: the contact could
        // otherwise broadcast a transfer this wallet considers cancelled.
        const before = f.requests.length
        await expect(
          f.chain.directMessages.send({
            wallet: reopened,
            recipient: bob.identity.address,
            items: [prepared.item],
          }),
        ).rejects.toThrow('cancelled before anything was sent')
        expect(f.requests).toHaveLength(before)
        expect(bobMailbox).toHaveLength(0)
        expect(toOneTimeAddresses()).toEqual([])
      } finally {
        await reopened.close()
      }
    })

    it('a released payment never reaches the contact: its item is refused before anything durable, and a later message does not carry it out', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      const key = prepared.item.ephemeralPubKey!
      expect(await alice.settleContactPayment!(key)).toBe('released')
      // Nothing takes the released transfer's nonce here: if its bytes ever left, it would land.
      const requests = f.requests.length
      const refused = await hostSends(prepared.item).catch((error) => error)
      expect(refused).toBeInstanceOf(ContactPaymentReleasedError)
      // The Retry of the same message, and a reconcile, fare no better.
      await expect(hostSends(prepared.item)).rejects.toBeInstanceOf(
        ContactPaymentReleasedError,
      )
      expect(f.requests).toHaveLength(requests)

      // An ordinary message from the same wallet settles earlier attempts first: there is no
      // attempt of the released message to submit.
      await f.chain.directMessages.send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [{ type: 'text', text: 'hello' }],
      })
      expect(f.requests).toHaveLength(requests + 1)
      const received = await poll(bob)
      expect(received.map((message) => message.items)).toEqual([
        [{ type: 'text', text: 'hello' }],
      ])
      await settle(bob)
      expect(coinsOf(bob)).toEqual([])
      expect(toOneTimeAddresses()).toEqual([])
      expect(mockBalances.get(prepared.stealthAddress.toLowerCase()) ?? 0n).toBe(0n)
      // The wallet keeps no copy of the signed transfer: not on the payment, not in the journal.
      expect(alice.getContactPayments!()[0].txHash).toBeUndefined()
      expect(
        (await alice.getNativeOperationHistory!({ limit: 100 })).operations
          .filter((row) => row.recipient === prepared.stealthAddress.toLowerCase())
          .map((row) => ({ cancelled: row.cancelled, signed: row.members[0]!.signed })),
      ).toEqual([{ cancelled: true, signed: null }])
    })

    it('reopen: released at the first pass, then the host retries its saved message and an ordinary message goes out: nothing of the payment leaves', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      await alice.close()
      const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      attach(reopened)
      try {
        installCanonicalDirectory(
          reopened,
          await f.directoryFor('alice-reopened-2', reopened, bob),
        )
        await reopened.resumeContactPayments!()
        expect(reopened.getContactPayments!()[0].state).toBe('released')
        const requests = f.requests.length
        // The chat store's automatic retry of the message it had saved.
        await expect(
          f.chain.directMessages.send({
            wallet: reopened,
            recipient: bob.identity.address,
            items: [prepared.item],
          }),
        ).rejects.toBeInstanceOf(ContactPaymentReleasedError)
        expect(reopened.pool.accountClaimedBy(await mainOf(reopened))).toBeUndefined()
        await f.chain.directMessages.send({
          wallet: reopened,
          recipient: bob.identity.address,
          items: [{ type: 'text', text: 'later' }],
        })
        expect(f.requests).toHaveLength(requests + 1)
        const received = await poll(bob)
        expect(
          received.flatMap((message) => message.items.map((item) => item.type)),
        ).toEqual(['text'])
        await settle(bob)
        expect(coinsOf(bob)).toEqual([])
        expect(toOneTimeAddresses()).toEqual([])
      } finally {
        await reopened.close()
      }
    })

    it('a payment whose message is being sent cannot be released, and a free message in flight counts as sent', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
        stampValue: 0n,
      })
      const key = prepared.item.ephemeralPubKey!
      // The free message is handed to the relay and the relay has not answered.
      const hold = f.holdNextRelayRequest()
      let freeDigest: string | undefined
      const sending = hostSends(prepared.item, {
        stampValue: 0n,
        onBeforeExposure: (digest: string) => {
          freeDigest = digest
        },
      })
      await hold.entered
      // Its digest was recorded before the relay was handed a byte, and it is in flight:
      // asked to settle now, the payment is NOT released.
      expect(alice.getContactPayments!()[0]).toMatchObject({
        state: 'prepared',
        holdsFunds: true,
      })
      const settling = alice.settleContactPayment!(key)
      // The request dies with no answer (the app stops here).
      hold.release('fail')
      await sending.catch(() => undefined)
      expect(await settling).not.toBe('released')
      expect(alice.getContactPayments!()[0].state).not.toBe('released')
      await alice.close()

      // After the restart it is still not released: the relay may hold the message. The wallet
      // finishes it instead, with the same transfer.
      const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      attach(reopened)
      try {
        installCanonicalDirectory(
          reopened,
          await f.directoryFor('alice-reopened-3', reopened, bob),
        )
        f.setPhase('delivered')
        for (let i = 0; i < 3; i++) await reopened.resumeContactPayments!()
        expect((await poll(bob))[0]?.payloadDigest).toBe(freeDigest)
        expect(reopened.getContactPayments!()).toEqual([
          expect.objectContaining({ state: 'paid', holdsFunds: false }),
        ])
        expect(toOneTimeAddresses()).toEqual([
          expect.objectContaining({ hash: prepared.txHash }),
        ])
      } finally {
        await reopened.close()
      }
    })

    it('a stop between marking a payment released and cancelling its transfer is finished at the next pass', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      const aliceMain = await mainOf(alice)
      await alice.close()
      // What such a stop leaves on disk: the record says released, the journal still holds
      // the signed transfer and with it the account.
      const location = `${f.config.walletStorageLocation}-evm-${aliceMain}`
      const store = await LevelRecordStore.open<ContactPayment>(
        location,
        CONTACT_PAYMENT_NAMESPACE,
      )
      const [saved] = store.all()
      await store.put(saved.stealthAddress, { ...saved, state: 'released' })
      await store.close()

      const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      attach(reopened)
      try {
        installCanonicalDirectory(
          reopened,
          await f.directoryFor('alice-reopened-4', reopened, bob),
        )
        await expect(
          reopened.sendNative({ recipient: { raw: '0x' + 'c8'.repeat(20) }, value: big }),
        ).rejects.toThrow('Insufficient unreserved native funds')
        await reopened.resumeContactPayments!()
        const spent = await reopened.sendNative({
          recipient: { raw: '0x' + 'c8'.repeat(20) },
          value: big,
        })
        expect(node.broadcasts).toEqual([
          expect.objectContaining({ from: aliceMain, hash: spent.txHash }),
        ])
        expect(mockBalances.get(prepared.stealthAddress.toLowerCase()) ?? 0n).toBe(0n)
      } finally {
        await reopened.close()
      }
    })

    it('settling a payment that stopped around signing cancels the signed transfer the journal holds', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      const aliceMain = await mainOf(alice)
      await alice.close()
      // What a stop between the signature and the record's update leaves: a planned record
      // that never learned of the signed row.
      const location = `${f.config.walletStorageLocation}-evm-${aliceMain}`
      const store = await LevelRecordStore.open<ContactPayment>(
        location,
        CONTACT_PAYMENT_NAMESPACE,
      )
      const [saved] = store.all()
      const { operationId: _op, rawTransaction: _raw, txHash: _hash, ...planned } = saved
      await store.put(saved.stealthAddress, { ...planned, state: 'planned' })
      await store.close()

      const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      attach(reopened)
      try {
        installCanonicalDirectory(
          reopened,
          await f.directoryFor('alice-reopened-5', reopened, bob),
        )
        expect(await reopened.settleContactPayment!(prepared.item.ephemeralPubKey!)).toBe(
          'released',
        )
        expect(
          (await reopened.getNativeOperationHistory!({ limit: 100 })).operations
            .filter((row) => row.recipient === prepared.stealthAddress.toLowerCase())
            .map((row) => row.cancelled),
        ).toEqual([true])
        await reopened.sendNative({
          recipient: { raw: '0x' + 'c9'.repeat(20) },
          value: big,
        })
        expect(node.broadcasts.map((tx) => tx.from)).toEqual([aliceMain])
      } finally {
        await reopened.close()
      }
    })

    it('the outgoing message is deleted before anything was sent: settle releases it', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      expect(await alice.settleContactPayment!(prepared.item.ephemeralPubKey!)).toBe(
        'released',
      )
      expect(held(alice)).toEqual([])
      expect(node.broadcasts).toEqual([])
      expect(await alice.settleContactPayment!('02' + '99'.repeat(32))).toBe('none')
    })

    it('once signed bytes may be exposed, deletion cannot release the original payment or message', async () => {
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      node.unreachable.add(alice)
      f.setPhase('fail')
      let digest: string | undefined
      await hostSends(prepared.item, {
        onAttemptCreated: (value: string) => {
          digest = value
        },
      }).catch(() => undefined)
      const key = prepared.item.ephemeralPubKey!
      expect(await alice.settleContactPayment!(key)).toBe('prepared')
      expect(held(alice)).toHaveLength(1)
      expect(node.broadcasts).toEqual([])
      node.unreachable.delete(alice)
      f.setPhase('delivered')
      await recoverMessage(alice, digest!)
      expect(alice.getContactPayments!()).toEqual([
        expect.objectContaining({ state: 'paid', holdsFunds: false }),
      ])
      expect(bobMailbox).toHaveLength(1)
      expect(toOneTimeAddresses()).toEqual([
        expect.objectContaining({ hash: prepared.txHash }),
      ])
    })

    it('the contact put the transfer on the chain while this wallet still waited: the original message still delivers without paying again', async () => {
      mockBalances.set(await mainOf(alice), VALUE + FEE)
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
        stampValue: 0n,
      })
      f.setPhase('fail')
      let digest: string | undefined
      await hostSends(prepared.item, {
        stampValue: 0n,
        onBeforeExposure: (value: string) => {
          digest = value
        },
      }).catch(() => undefined)
      expect(held(alice)).toHaveLength(1)
      // Someone holding the message broadcasts the carried transfer.
      await bob.provider.broadcastTransaction('0x' + prepared.item.transactions![0])
      f.setPhase('delivered')
      await recoverMessage(alice, digest!)
      expect(alice.getContactPayments!()).toEqual([
        expect.objectContaining({ state: 'paid', holdsFunds: false }),
      ])
      expect(toOneTimeAddresses()).toHaveLength(1)
      expect(bobMailbox).toHaveLength(1)
    })

    it('the original payment can fund its stamp from reserved change while another operation cannot take it', async () => {
      mockBalances.set(await mainOf(alice), VALUE + STAMP + 3n * FEE)
      const prepared = await alice.prepareContactPayment!({
        recipient: bob.identity.address,
        value: VALUE,
      })
      expect(held(alice)).toHaveLength(1)
      await expect(
        alice.sendNative({ recipient: { raw: '0x' + 'c4'.repeat(20) }, value: STAMP }),
      ).rejects.toThrow('Insufficient unreserved native funds')
      let digest: string | undefined
      await hostSends(prepared.item, {
        onAttemptCreated: (value: string) => {
          digest = value
        },
      }).catch((error) => {
        expect(error).toBeInstanceOf(MonadStampPendingAttemptError)
      })
      await recoverMessage(alice, digest!)
      expect(toOneTimeAddresses()).toEqual([
        expect.objectContaining({ hash: prepared.txHash }),
      ])
      expect(alice.getContactPayments!()).toEqual([
        expect.objectContaining({ state: 'paid', holdsFunds: false }),
      ])
      expect(
        alice.getNativeOperations!().filter(
          (op) => op.recipient === prepared.stealthAddress.toLowerCase(),
        ),
      ).toHaveLength(1)
      expect(bobMailbox).toHaveLength(1)
    })
  })

  it('a coin list that did not exist when the host read the mailbox still finds the money: its first read starts at the beginning', async () => {
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
    })
    await bob.close()
    const root = mkdtempSync(join(tmpdir(), 'contact-payment-late-store-'))
    extraRoots.push(root)
    const chain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const late = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
    attach(late)
    try {
      installCanonicalDirectory(late, await f.directoryFor('bob-late', late, alice))
      // The host's cursor is already past the message.
      const afterEverything = bobMailbox[0].timestampMs + 1_000
      const handed = await chain.directMessages.fetchSince({
        wallet: late,
        sinceMs: afterEverything,
      })
      expect(handed).toEqual([])
      expect(coinsOf(late)).toEqual([
        expect.objectContaining({ address: sent.stealthAddress.toLowerCase() }),
      ])
      expect(stampsOf(late)).toHaveLength(1)
      await settle(late)
      mockBalances.set(await mainOf(late), 0n)
      expect(await late.getBalance()).toBe(VALUE + STAMP)

      // Done once: a later read asks the relay only what the host asked.
      const mailbox = jest.requireMock('@frank/cashweb/relay/mailbox-client')
      const reads = () =>
        (mailbox.fetchCanonicalMailboxPage as jest.Mock).mock.calls.filter(
          call => (call[0].sinceMs ?? 0) < afterEverything,
        ).length
      const before = reads()
      await chain.directMessages.fetchSince({ wallet: late, sinceMs: afterEverything })
      expect(reads()).toBe(before)
    } finally {
      await late.close()
    }
  })

  it('a mailbox read that stops at the page limit says so, and the coin list does not take it for the whole mailbox', async () => {
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const mailbox = jest.requireMock('@frank/cashweb/relay/mailbox-client')
    const page = mailbox.fetchCanonicalMailboxPage as jest.Mock
    const whole = page.getMockImplementation()!
    // A relay that always has another page.
    let pageCursor = 0
    page.mockImplementation(async () => ({
      records: [],
      nextCursor: `more-${++pageCursor}`,
    }))
    let truncated = 0
    const before = page.mock.calls.length
    try {
      await expect(
        f.chain.directMessages.fetchSince({
          wallet: bob,
          sinceMs: 0,
          onTruncated: () => truncated++,
        }),
      ).rejects.toThrow('Canonical mailbox read has no complete timestamp prefix')
      expect(page.mock.calls.length - before).toBe(8)
      expect(truncated).toBe(1)
      expect(coinsOf(bob)).toEqual([])
    } finally {
      page.mockImplementation(whole)
    }

    // The relay answers in full again, and the host's cursor has moved past the message: the
    // coin list still reads the part it never finished, and finds the money.
    await f.chain.directMessages.fetchSince({
      wallet: bob,
      sinceMs: bobMailbox[0].timestampMs + 1_000,
    })
    expect(coinsOf(bob)).toEqual([
      expect.objectContaining({ address: sent.stealthAddress.toLowerCase() }),
    ])
  })

  it('shows the chain amount, not the larger amount the sender wrote', async () => {
    // An independently signed transfer has no locally composed contact-operation binding.
    // A malicious sender can state an inflated amount; only the actual receipt may count.
    const derived = deriveEvmStealthAddress({ recipientSpendPubKey: bob.identity.compressedPubKey })
    const signer = new Wallet('0x' + '0f'.repeat(32))
    mockBalances.set(signer.address.toLowerCase(), VALUE + FEE)
    const raw = await signer.signTransaction({ chainId: 10143, nonce: 0,
      to: derived.stealthAddress, value: VALUE, gasLimit: 21000n, gasPrice: 1n })
    await alice.provider.broadcastTransaction(raw)
    const sent = { stealthAddress: derived.stealthAddress }
    const honest = { ephemeralPubKey: toHex(derived.ephemeralPubKey), transactions: [raw.slice(2)] }
    await bob.close()
    bobMailbox.length = 0

    // Bob again, with nothing recorded, receiving the same transfer under an inflated claim.
    const root = mkdtempSync(join(tmpdir(), 'contact-payment-claim-'))
    extraRoots.push(root)
    const chain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const fresh = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
    attach(fresh)
    try {
      installCanonicalDirectory(fresh, await f.directoryFor('bob-claim', fresh, alice))
      await f.chain.directMessages.send({
        wallet: alice,
        recipient: fresh.identity.address,
        items: [
          {
            type: 'stealth',
            networkTag: 'MONT',
            keyType: 1,
            ephemeralPubKey: honest.ephemeralPubKey,
            transactions: honest.transactions,
            amount: Number(VALUE) * 1_000_000,
          },
        ],
      })
      await chain.directMessages.fetchSince({ wallet: fresh, sinceMs: 0 })
      mockBalances.set(await mainOf(fresh), 0n)
      await settle(fresh)
      expect(await fresh.getBalance()).toBe(VALUE + STAMP)
      expect(coinsOf(fresh)).toEqual([
        expect.objectContaining({
          address: sent.stealthAddress.toLowerCase(),
          status: 'received',
          amountWei: VALUE,
          claimedAmountWei: VALUE * 1_000_000n,
        }),
      ])
    } finally {
      await fresh.close()
    }
  })

  it('a claimed payment whose transfer the chain never sees is reported as not received and never counted', async () => {
    const sent = await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: '02' + '22'.repeat(32),
          // A hash the node has never heard of, and nothing to broadcast.
          transactions: ['77'.repeat(32)],
          amount: 9_000_000,
        },
      ],
    })
    await poll(bob)
    const bobMain = await mainOf(bob)
    const own = mockBalances.get(bobMain)!
    await settle(bob)
    // Even with money sitting at the one-time address (from anyone), an unverified coin is
    // not balance: the transfer the message named is not on the chain.
    mockBalances.set(coinsOf(bob)[0].address, 9_000_000n)
    await settle(bob)
    expect(await bob.getBalance()).toBe(own + STAMP)
    // The stub relay stamps messages in 1970: long past the bound, so the claim is called what
    // it is. (`evm-coin-store.jest.test.ts` covers the bound itself.)
    expect(coinsOf(bob)).toEqual([
      expect.objectContaining({
        status: 'not-received',
        claimedAmountWei: 9_000_000n,
        spendable: false,
      }),
    ])
    // The message as a whole: its stamp landed, its claimed payment did not.
    expect(bob.getMessagePayment!(sent.payloadDigest)).toMatchObject({
      status: 'not-received',
      receivedWei: STAMP,
      statedWei: 9_000_000n + STAMP,
    })
  })

  it('a sender cannot forge "received" with someone else\'s mined transaction or a zero-value transfer', async () => {
    // A real, mined, unrelated transaction: alice paying carol.
    const carol = '0x' + 'c6'.repeat(20)
    const unrelatedSigner = new Wallet('0x' + '0c'.repeat(32))
    mockBalances.set(unrelatedSigner.address.toLowerCase(), 1000n + FEE)
    const unrelatedRaw = await unrelatedSigner.signTransaction({ chainId: 10143,
      nonce: 0, to: carol, value: 1000n, gasLimit: 21000n, gasPrice: 1n })
    const unrelated = { txHash: (await alice.provider.broadcastTransaction(unrelatedRaw)).hash }
    expect(node.receipts.has(unrelated.txHash)).toBe(true)
    const byHash = await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: '02' + '44'.repeat(32),
          transactions: [unrelated.txHash.slice(2)],
          amount: 1_000_000_000,
        },
      ],
    })
    // And a properly signed transfer, of nothing, to the very one-time address bob derives.
    const ephemeral = new Wallet('0x' + '0e'.repeat(32)).signingKey.compressedPublicKey
    const target = deriveEvmStealthPrivateKey({
      recipientSpendSecret: bob.identity.toPrivateKeyHex(),
      ephemeralPubKey: getBytes(ephemeral),
    }).stealthAddress
    const zero = await new Wallet('0x' + '0d'.repeat(32)).signTransaction({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      to: target,
      value: 0n,
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    const byZero = await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: ephemeral.slice(2),
          transactions: [zero.slice(2)],
          amount: 1_000_000_000,
        },
      ],
    })
    await poll(bob)
    await settle(bob)

    expect(coinsOf(bob).map(coin => coin.address)).toContain(target.toLowerCase())
    expect(coinsOf(bob)).toHaveLength(2)
    for (const coin of coinsOf(bob)) {
      expect(coin.status).not.toBe('received')
      expect(coin).toMatchObject({
        amountWei: 0n,
        claimedAmountWei: 1_000_000_000n,
        spendable: false,
      })
      expect(coin.receivedAmountWei).toBeUndefined()
    }
    for (const sent of [byHash, byZero]) {
      const payment = bob.getMessagePayment!(sent.payloadDigest)
      expect(payment.status).not.toBe('received')
      // Only the message's own stamp ever arrived.
      expect(payment.receivedWei).toBe(STAMP)
    }
    // The zero-value transfer was never handed to the node by bob's wallet.
    expect(node.broadcasts.some(tx => tx.value === 0n)).toBe(false)
  })

  it('an unverified coin is never an input: not of a native send, not of a sweep', async () => {
    const digest = 'ab'.repeat(32)
    // A claim with no transfer behind it, and real money parked at its address by someone else.
    await bob.recordStealthPayment(
      {
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: '02' + '33'.repeat(32),
        transactions: ['66'.repeat(32)],
        amount: 7_000_000,
      },
      { payloadDigest: digest, timestampMs: 1 },
    )
    await settle(bob)
    const [claimed] = coinsOf(bob)
    mockBalances.set(claimed.address, 7_000_000n)
    mockBalances.set(await mainOf(bob), 100_000n)
    await settle(bob)
    expect(claimed.spendable).toBe(false)
    expect(await bob.getBalance()).toBe(100_000n)

    // A send the main account cannot cover is refused; the claimed coin is not reached for.
    await expect(
      bob.sendNative({ recipient: { raw: '0x' + 'c2'.repeat(20) }, value: 1_000_000n }),
    ).rejects.toThrow('Insufficient unreserved native funds')
    // A sweep leaves it alone too.
    expect(await bob.sweepReceivedCoins!({ payloadDigests: [digest] })).toEqual({
      [digest]: { outcome: 'none' },
    })
    expect(node.broadcasts.filter(tx => tx.from === claimed.address)).toEqual([])
    expect(mockBalances.get(claimed.address)).toBe(7_000_000n)
  })

  it('a payment whose nonce went to another transaction is failed: shown, kept, never counted', async () => {
    // Alice signs and delivers, and her own broadcast does not go out.
    mockBalances.set(await mainOf(alice), VALUE + FEE)
    node.unreachable.add(alice)
    const sent = await sendContact({
      recipient: bob.identity.address,
      value: VALUE,
      stampValue: 0n,
    })
    expect(toOneTimeAddresses()).toHaveLength(0)
    // Another transaction of alice's takes that nonce.
    const aliceMain = await mainOf(alice)
    node.nonces.set(aliceMain, (node.nonces.get(aliceMain) ?? 0) + 1)

    await poll(bob)
    mockBalances.set(await mainOf(bob), 0n)
    await settle(bob)
    expect(coinsOf(bob)).toEqual([
      expect.objectContaining({
        address: sent.stealthAddress.toLowerCase(),
        status: 'failed',
        amountWei: 0n,
        claimedAmountWei: VALUE,
        spendable: false,
      }),
    ])
    expect(await bob.getBalance()).toBe(0n)
    expect(bob.getMessagePayment!(sent.payloadDigest).status).toBe('failed')
    // Later reads only look for a late receipt: nothing is broadcast again, and it stays failed.
    const broadcasts = jest.mocked(bob.provider.broadcastTransaction).mock.calls.length
    await settle(bob)
    expect(jest.mocked(bob.provider.broadcastTransaction).mock.calls.length).toBe(
      broadcasts,
    )
    expect(coinsOf(bob)[0].status).toBe('failed')
  })

  it('refuses before anything is signed when the contact is unpublished or the wallet cannot pay', async () => {
    await expect(
      alice.sendToContact!({
        recipient: { raw: '0x' + 'ee'.repeat(20) },
        value: VALUE,
      }),
    ).rejects.toThrow()
    mockBalances.set(await mainOf(alice), VALUE)
    await expect(
      alice.sendToContact!({ recipient: bob.identity.address, value: VALUE }),
    ).rejects.toThrow('Insufficient funds for the payment and its message stamp')
    // More than the message item can state (its amount is an unsigned 64-bit field).
    await expect(
      alice.sendToContact!({ recipient: bob.identity.address, value: 2n ** 64n }),
    ).rejects.toThrow(
      'This payment is larger than a single contact payment can carry (about 18.4 MONT); send it in parts',
    )
    expect(alice.getContactPayments!()).toEqual([])
    expect(alice.getNativeOperations!()).toEqual([])
    expect(node.broadcasts).toEqual([])
    expect(bobMailbox).toEqual([])
  })

  describe('the stamps of received messages', () => {
    // A stamp this large is paid as two payments, to two one-time accounts.
    const BIG = 1_000_000n
    const text = (body: string) => [{ type: 'text' as const, text: body }]
    const paid = (body: string, stampValue = BIG) =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: bob.identity.address,
        items: text(body),
        stampValue,
      })
    const stampsFor = (wallet: EvmChainWalletHandle, digest: string) =>
      stampsOf(wallet).filter(coin => coin.payloadDigest === digest)
    const held = (coins: ReceivedPayment[]) =>
      coins.reduce((sum, coin) => sum + (mockBalances.get(coin.address) ?? 0n), 0n)
    const sweepsOf = async (wallet: EvmChainWalletHandle) => {
      const main = await mainOf(wallet)
      return wallet.getNativeOperations!().filter(row => row.recipient === main)
    }

    it('the relay only delivered: the wallet broadcasts the carried transactions, sees them included, and the stamp is spendable money', async () => {
      // The sender's own broadcast does not get out (it goes offline as the relay answers),
      // and the relay stand-in stored the message and broadcast nothing.
      mockBalances.set(await mainOf(alice), BIG + FEE)
      const senderBroadcast = jest.mocked(alice.provider.broadcastTransaction)
      const real = senderBroadcast.getMockImplementation()!
      senderBroadcast.mockRejectedValue(new Error('offline'))
      const sent = await paid('hello')
      senderBroadcast.mockImplementation(real)
      expect(node.broadcasts).toEqual([])
      mockBalances.set(await mainOf(bob), 0n)

      const [message] = await f.chain.directMessages.fetchSince({
        wallet: bob,
        sinceMs: 0,
      })
      const stamps = stampsFor(bob, sent.payloadDigest)
      expect(stamps.length).toBe(message.stampPayments.length)
      expect(stamps.map(coin => coin.address).sort()).toEqual(
        message.stampPayments.map(p => p.destinationAddress.toLowerCase()).sort(),
      )
      expect(stamps.reduce((sum, coin) => sum + coin.claimedAmountWei, 0n)).toBe(BIG)
      for (const coin of stamps)
        expect(coin).toMatchObject({
          origin: 'stamp',
          amountWei: 0n,
          spendable: false,
          payloadDigest: sent.payloadDigest,
        })
      // The delivery record's figure is the sender's statement; the wallet's is the chain's.
      expect(message.stampValueWei).toBe(BIG)
      expect(bob.getMessagePayment!(sent.payloadDigest)).toMatchObject({
        receivedWei: 0n,
        statedWei: BIG,
      })

      // "Has the payment for this message landed?" Asked until the chain says so: the wallet
      // broadcasts the carried transactions, then sees them included.
      await bob.checkMessagePayment!(sent.payloadDigest)
      expect(
        node.broadcasts.map(tx => ({ to: tx.to, value: tx.value })).sort((a, b) =>
          a.to.localeCompare(b.to),
        ),
      ).toEqual(
        message.stampPayments
          .map(p => ({ to: p.destinationAddress.toLowerCase(), value: p.valueWei }))
          .sort((a, b) => a.to.localeCompare(b.to)),
      )
      expect(await bob.checkMessagePayment!(sent.payloadDigest)).toMatchObject({
        status: 'received',
        receivedWei: BIG,
        statedWei: BIG,
      })
      // Nothing pending: asking again makes no request at all.
      const requests = () =>
        jest.mocked(bob.provider.getTransactionReceipt).mock.calls.length +
        jest.mocked(bob.provider.broadcastTransaction).mock.calls.length +
        jest.mocked(bob.provider.getTransaction).mock.calls.length
      const before = requests()
      await bob.checkMessagePayment!(sent.payloadDigest)
      expect(requests()).toBe(before)

      // In the balance, and spent by an ordinary send, signed with a stamp account's key.
      bob.invalidateBalanceCache!()
      expect(await bob.getBalance()).toBe(BIG)
      const carol = '0x' + 'c3'.repeat(20)
      const spent = await bob.sendNative({ recipient: { raw: carol }, value: 100_000n })
      const spend = node.broadcasts.find(tx => tx.hash === spent.txHash)!
      expect(spend).toMatchObject({ to: carol, value: 100_000n })
      expect(stamps.map(coin => coin.address)).toContain(spend.from)
    })

    it('before a message is deleted its unspent stamps are swept to the seed-derived main account, each in a recorded operation', async () => {
      const first = await paid('one')
      const second = await paid('two')
      await poll(bob)
      await settle(bob)
      const bobMain = await mainOf(bob)
      const before = mockBalances.get(bobMain)!
      const firstStamps = stampsFor(bob, first.payloadDigest)
      const secondStamps = stampsFor(bob, second.payloadDigest)
      expect([...firstStamps, ...secondStamps].every(coin => coin.spendable)).toBe(true)
      expect(held(firstStamps)).toBe(BIG)

      const answer = await bob.sweepReceivedCoins!({
        payloadDigests: [first.payloadDigest],
      })
      expect(answer).toEqual({ [first.payloadDigest]: { outcome: 'swept' } })
      // The money is at the main account, which a restore from the seed finds.
      expect(mockBalances.get(bobMain)).toBe(
        before + BIG - BigInt(firstStamps.length) * FEE,
      )
      expect(held(firstStamps)).toBe(0n)
      // Through the wallet's journal: an operation per coin, paying the main account from it.
      const sweeps = await sweepsOf(bob)
      expect(sweeps.map(row => row.members[0].source).sort((a, b) =>
        a.address.localeCompare(b.address),
      )).toEqual(
        byAddress(firstStamps).map(coin => ({ kind: 'coin', address: coin.address })),
      )
      expect(sweeps.every(row => row.members[0].observation.state === 'included-success')).toBe(true)
      // The other message's stamps were not touched.
      expect(held(secondStamps)).toBe(BIG)
      // Asking again signs nothing new.
      const broadcasts = node.broadcasts.length
      expect(
        await bob.sweepReceivedCoins!({ payloadDigests: [first.payloadDigest] }),
      ).toEqual({ [first.payloadDigest]: { outcome: 'swept' } })
      expect(node.broadcasts).toHaveLength(broadcasts)
      expect(await sweepsOf(bob)).toHaveLength(sweeps.length)
    })

    it('clearing a conversation sweeps every unspent stamp in it', async () => {
      const digests = [
        (await paid('one')).payloadDigest,
        (await paid('two')).payloadDigest,
        (await paid('three')).payloadDigest,
      ]
      await poll(bob)
      await settle(bob)
      const bobMain = await mainOf(bob)
      const before = mockBalances.get(bobMain)!
      const coins = stampsOf(bob)
      expect(held(coins)).toBe(3n * BIG)

      const answer = await bob.sweepReceivedCoins!({
        payloadDigests: [...digests, 'ff'.repeat(32)],
      })
      expect(answer).toEqual({
        [digests[0]]: { outcome: 'swept' },
        [digests[1]]: { outcome: 'swept' },
        [digests[2]]: { outcome: 'swept' },
        // A message with no coin needs no sweep.
        ['ff'.repeat(32)]: { outcome: 'none' },
      })
      expect(mockBalances.get(bobMain)).toBe(
        before + 3n * BIG - BigInt(coins.length) * FEE,
      )
      expect(await sweepsOf(bob)).toHaveLength(coins.length)
      expect(stampsOf(bob).every(coin => !coin.spendable)).toBe(true)
    })

    it('with the node unreachable nothing is swept and the answer says the message must stay', async () => {
      const sent = await paid('keep me')
      await poll(bob)
      await settle(bob)
      const stamps = stampsFor(bob, sent.payloadDigest)
      jest
        .spyOn(bob.provider, 'getBalance')
        .mockRejectedValue(new Error('node unreachable'))

      const answer = await bob.sweepReceivedCoins!({
        payloadDigests: [sent.payloadDigest],
      })
      expect(answer).toEqual({
        [sent.payloadDigest]: { outcome: 'failed', reason: 'node unreachable' },
      })
      expect(held(stamps)).toBe(BIG)
      expect(await sweepsOf(bob)).toEqual([])
      // The coins and their keys are still recorded.
      expect(stampsFor(bob, sent.payloadDigest)).toEqual(stamps)
    })

    it('a stamp worth less than its own move is left where it is and stays recorded', async () => {
      // 30,000 in all against a move that costs 21,000: moving it would cost more than it moves.
      const sent = await paid('tiny', 30_000n)
      await poll(bob)
      await settle(bob)
      const stamps = stampsFor(bob, sent.payloadDigest)
      const answer = await bob.sweepReceivedCoins!({
        payloadDigests: [sent.payloadDigest],
      })
      expect(answer).toEqual({ [sent.payloadDigest]: { outcome: 'none' } })
      expect(held(stamps)).toBe(30_000n)
      expect(await sweepsOf(bob)).toEqual([])
      expect(stampsFor(bob, sent.payloadDigest)).toEqual(stamps)
    })
  })
})

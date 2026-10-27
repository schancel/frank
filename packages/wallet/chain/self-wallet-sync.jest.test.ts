/**
 * A wallet's sync note to itself, across the real canonical path, and what a native send does
 * (and does not) send.
 *
 * Two handles of the SAME account stand for two devices: separate storage, one identity, one relay
 * mailbox. A `wallet-sync` note addressed to the account's own mailbox is read by device two and
 * handed to the wallet sync boundary; from anyone else it is unsupported. A note to oneself is
 * free: it carries no stamp. After a native transfer the wallet sends one itself. One process may hold an
 * account open once, so device one is closed before device two is opened. Real typed custody, real
 * journals, real sealing and opening; only the chain RPC and the relay's HTTP surface are
 * stand-ins (`canonical-two-wallets.testutil.ts`).
 */
import * as syncDispatch from '@frank/cashweb/sync-dispatcher'
import * as relayDm from '@frank/cashweb/relay/canonical-dm'
import type {
  MessageItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import { restoreCanonicalRequest, type CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import {
  FrankCodecError,
  MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  encodePluginMessageItem,
  parseFrame,
  toHex,
} from '@frank/codec'
import {
  Transaction,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'

import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { outboxMessageCodec } from '../journal/journal-codec'
import * as wire from '../message-item-plugins/wire'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { isDirectMessageNotAttempted } from './active-chain'
import { SealedSelfCopyTooLargeError } from './canonical-dm'
import {
  MessageItemEncodeError,
  pluginCapabilitiesNotYetAvailable,
} from '@frank/cashweb/message-items/registry'
import {
  STAMP,
  START_BALANCE,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  providerBroadcasts,
  roots,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { SELF_NOTE_RETRY_MS, createEvmChain, installCanonicalDirectory } from './evm-chain'
import type { EvmChainConfig } from './evm-chain-config'
import { EvmInputAdmissionError } from '../evm-input-admission'
import { SubAccountSpendRefusedError } from '../evm-account-pool'
import { evmWalletInternals } from '../evm-wallet'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type EvmTransactionSetPolicy,
} from '../evm-transaction-set-types'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)
const subjectOf = (wallet: EvmChainWalletHandle) =>
  toHex(wallet.identity.compressedPubKey)

/** The chain as a native send sees it: a broadcast transfer is mined at once, with a receipt. */
function minesNativeTransfers(wallet: EvmChainWalletHandle) {
  const transactions = new Map<string, TransactionResponse>()
  const receipts = new Map<string, TransactionReceipt>()
  const blockHash = '0x' + '11'.repeat(32)
  jest
    .spyOn(wallet.provider, 'getTransaction')
    .mockImplementation(async hash => transactions.get(hash) ?? null)
  jest
    .spyOn(wallet.provider, 'getTransactionReceipt')
    .mockImplementation(async hash => receipts.get(hash) ?? null)
  const broadcast = wallet.provider.broadcastTransaction.bind(wallet.provider)
  jest
    .spyOn(wallet.provider, 'broadcastTransaction')
    .mockImplementation(async raw => {
      const answer = await broadcast(raw)
      const tx = Transaction.from(raw)
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
        gasUsed: 21000n,
      } as TransactionReceipt)
      return answer
    })
}

// Resolve the original signed transaction across the active-to-history handoff.
async function operationForTransaction(wallet: EvmChainWalletHandle, txHash: string) {
  let rows = wallet.getNativeOperations!().filter(row =>
    row.members.some(member => member.signed?.transactionHash === txHash),
  )
  if (rows.length === 0) {
    const history = await wallet.getNativeOperationHistory!({ limit: 100 })
    expect(history.next).toBeUndefined()
    rows = history.operations.filter(row =>
      row.members.some(member => member.signed?.transactionHash === txHash),
    )
  }
  expect(rows).toHaveLength(1)
  const row = await wallet.readNativeOperation!(rows[0].operationId)
  expect(row).toBeDefined()
  return row!
}

describe("a wallet's sync note to itself", () => {
  jest.setTimeout(120_000)
  let one: Fixture
  let two: Fixture | undefined
  /** The account's one relay mailbox, read by both devices. */
  let mailbox: InboxRecord[]
  let bobMailbox: InboxRecord[]
  let applied: jest.SpyInstance
  let routeByRecipient = false
  /** The relay is unreachable for notes to self only; each request's addressee is recorded. */
  let selfUnreachable = false
  let addressed: ('self' | 'peer')[] = []

  /** A directory in which the wallet can also find itself, as a relay answers for any key. */
  async function selfAware(f: Fixture) {
    const base = await f.directoryFor('alice', f.alice, f.bob)
    const subject = subjectOf(f.alice)
    const address = f.alice.identity.address.raw.toLowerCase()
    return {
      ...base,
      fetch: async (url: string, init: Parameters<CanonicalFetch>[1]) => {
        if (routeByRecipient && f === one) {
          const request = restoreCanonicalRequest({
            body: new Uint8Array(init.body!), contentType: init.headers['Content-Type'],
          })
          const recipient = request.identity.recipient
          const toSelf = recipient === f.alice.identity.address.raw.toLowerCase()
          addressed.push(toSelf ? 'self' : 'peer')
          if (toSelf && selfUnreachable) throw new Error('relay unreachable')
          expect([f.alice.identity.address.raw.toLowerCase(), f.bob.identity.address.raw.toLowerCase()]).toContain(recipient)
          f.setMailbox(recipient === f.alice.identity.address.raw.toLowerCase() ? mailbox : bobMailbox)
        }
        return base.fetch!(url, init)
      },
      peerCurrent: async (
        wanted: { address: string } | { subject: string },
      ) =>
        ('subject' in wanted
          ? wanted.subject === subject
          : wanted.address.toLowerCase() === address)
          ? {
              subject,
              endpoint: base.homeEndpoint,
              current: await base.selfCurrent(),
            }
          : base.peerCurrent(wanted),
    }
  }

  beforeEach(async () => {
    routeByRecipient = false
    selfUnreachable = false
    addressed = []
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    providerBroadcasts.length = 0
    useProviderStandIns()
    one = await device()
    two = undefined
    mailbox = []
    bobMailbox = []
    mailboxes.set(subjectOf(one.alice), mailbox)
    mailboxes.set(subjectOf(one.bob), bobMailbox)
    applied = jest.spyOn(syncDispatch, 'applyWalletSyncItem')
  })
  afterEach(async () => {
    useProviderStandIns(false)
    jest.restoreAllMocks()
    await (two ?? one).close()
  })

  /** The directory each device's Alice was given, to give it again after a restart. */
  const aliceDirectories = new Map<Fixture, Awaited<ReturnType<typeof selfAware>>>()
  async function device(): Promise<Fixture> {
    const f = await fixture()
    const own = await selfAware(f)
    aliceDirectories.set(f, own)
    installCanonicalDirectory(f.alice, own)
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    return f
  }
  /** The same account opened on another device: device one is closed, its storage is not used. */
  async function otherDevice(): Promise<Fixture> {
    const subject = subjectOf(one.alice)
    const balances = new Map(mockBalances)
    await one.close()
    two = await device()
    // The chain did not change because another device was opened.
    for (const [address, value] of balances) mockBalances.set(address, value)
    expect(subjectOf(two.alice)).toBe(subject)
    return two
  }

  const note = (): WalletSyncItem => ({
    type: 'wallet-sync',
    direction: 'out',
    chainIdentifier: 'monad-testnet',
    txHash: '0x' + 'ab'.repeat(32),
    spentInputs: [{ address: '0x' + '0a'.repeat(20), nonce: 3, valueWei: '21' }],
    createdOutputs: [{ address: '0x' + '0b'.repeat(20), valueWei: '20' }],
    timestamp: 1728000000000,
  })
  const read = async (
    f: Fixture,
    wallet: EvmChainWalletHandle,
    sinceMs = 0,
    onForeignWalletSync?: (item: WalletSyncItem) => Promise<void>,
  ) => {
    const passed: [number, string][] = []
    const held: number[] = []
    const messages = await f.chain.directMessages.fetchSince({
      wallet,
      sinceMs,
      onQuarantinedTimestamp: (time, digest) => passed.push([time, digest]),
      onIncompleteTimestamp: time => held.push(time),
      onForeignWalletSync,
    })
    return { messages, passed, held }
  }

  it('travels to the same account on another device and is applied there once, never shown as a message', async () => {
    one.setMailbox(mailbox)
    const sent = await one.chain.directMessages.send({
      wallet: one.alice,
      recipient: one.alice.identity.address,
      items: [note()],
      stampValue: 0n,
    })
    one.setMailbox(undefined)
    expect(mailbox).toHaveLength(1)
    // What the note costs: nothing. No stamp, no payment, no funded sender account.
    expect(sent.stampValueWei).toBe(0n)
    expect(sent.stampPayments).toEqual([])
    expect(mockFunded).toHaveLength(0)

    const other = await otherDevice()
    const first = await read(other, other.alice)
    expect(first.messages).toEqual([])
    expect(first.held).toEqual([])
    expect(first.passed).toEqual([[mailbox[0].timestampMs, sent.payloadDigest]])
    expect(applied).toHaveBeenCalledTimes(1)
    expect(applied.mock.calls[0][0]).toBe(other.alice)
    expect(applied.mock.calls[0][1]).toEqual(note())
    await expect(applied.mock.results[0].value).resolves.toEqual({})

    // Read again from the start, as a poll whose cursor has not moved does: nothing new.
    const again = await read(other, other.alice)
    expect(again.messages).toEqual([])
    expect(again.passed).toEqual(first.passed)
    expect(applied).toHaveBeenCalledTimes(1)
  })

  describe('after a sealed send, which leaves no outbox row at the relay', () => {
    /** The note to self a sealed send wrote: the one record in the account's own mailbox. */
    function selfCopyOf(sentDigest: string) {
      expect(mailbox).toHaveLength(1)
      const delivery = parseFrame(mailbox[0].delivery)
      if (delivery.kind !== 'parsed' || delivery.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
        throw new Error('expected a delivery frame')
      expect(toHex(delivery.typed.payloadDigest)).not.toBe(sentDigest)
      return mailbox[0]
    }
    /** The self copy's spend fact for one signed transaction of the bundle. */
    const spendFact = (rawTx: string): WalletSyncItem => {
      const tx = Transaction.from(rawTx)
      return {
        type: 'wallet-sync',
        direction: 'out',
        chainIdentifier: 'monad-testnet',
        txHash: tx.hash!,
        rawTx,
        spentInputs: [{ address: tx.from!.toLowerCase(), nonce: tx.nonce }],
      }
    }

    it('shows the sent message and its spent coins on the other device, once however often it is read', async () => {
      routeByRecipient = true
      const id = '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d'
      const sent = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [{ type: 'text', text: 'sealed and paid' }],
        stampValue: STAMP,
        messageId: id,
        sealedSender: true,
      })
      // The recipient has the message, and the relay was not told who sent it.
      expect(bobMailbox).toHaveLength(1)
      const original = parseFrame(bobMailbox[0].delivery)
      if (original.kind !== 'parsed' || original.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
        throw new Error('expected a delivery frame')
      expect(original.typed.payloadFrame.typed).toEqual(
        expect.objectContaining({ sender: undefined }),
      )
      routeByRecipient = false
      // Every transaction the bundle signed: the stamp payments and the wallet's own moves.
      const bundle = one.alice.transactionSetPreparer!
        .getOperation(`stamp-${id.replace(/-/g, '')}`)!
        .members.map(member => member.signed!.rawTransaction)
      expect(bundle.length).toBeGreaterThan(0)
      const spent = bundle.map(rawTx => {
        const tx = Transaction.from(rawTx)
        return { account: tx.from!.toLowerCase(), nonce: tx.nonce }
      })

      // The sending device reads its own note: the message it already has, nothing held.
      const own = await read(one, one.alice)
      expect(own.held).toEqual([])
      expect(own.messages.map(message => message.payloadDigest)).toEqual([sent.payloadDigest])
      applied.mockClear()

      // The other device listed the account's coins, unspent, before the note arrived.
      const other = await otherDevice()
      const coins = evmWalletInternals(other.alice).coinList!
      const sync = evmWalletInternals(other.alice).coinListSync!
      const known = [...new Set(spent.map(coin => coin.account))]
        .filter(account => sync.keyOf(account) !== undefined)
        .map(account => ({
          account,
          nonce: Math.min(...spent.filter(coin => coin.account === account).map(coin => coin.nonce)),
        }))
      expect(known.length).toBeGreaterThan(0)
      for (const coin of known) {
        await coins.put({
          account: coin.account,
          nonce: coin.nonce,
          privateKey: sync.keyOf(coin.account)!,
          valueWei: START_BALANCE,
          origin: 'root',
        })
        expect(sync.isDirty(coin.account)).toBe(false)
      }

      // The chain cannot be read when the note arrives. The spent coins still leave the list,
      // durably (never offered again, also after a restart), and their accounts stay due for a
      // read: the next refresh of the list lists the successors.
      const down = jest
        .spyOn(sync, 'refreshAccounts')
        .mockRejectedValue(new Error('rpc down'))
      const first = await read(other, other.alice)
      down.mockRestore()
      for (const coin of known) {
        expect(coins.get(coin.account, coin.nonce)).toBeUndefined()
        expect(sync.isDirty(coin.account)).toBe(true)
      }
      expect(sync.settled()).toBe(false)
      await sync.refresh()
      expect(first.held).toEqual([])
      expect(first.messages).toHaveLength(1)
      const shown = first.messages[0]
      expect(shown.outbound).toBe(true)
      expect(shown.payloadDigest).toBe(sent.payloadDigest)
      expect(shown.messageId).toBe(id)
      expect(shown.recipientAddress.raw.toLowerCase()).toBe(
        one.bob.identity.address.raw.toLowerCase(),
      )
      expect(shown.items).toEqual([{ type: 'text', text: 'sealed and paid' }])
      expect(shown.stampValueWei).toBe(sent.stampValueWei)
      // Each signed transaction of the bundle reached the wallet sync boundary as the self copy
      // carries it.
      const facts = applied.mock.calls.map(call => call[1] as WalletSyncItem)
      for (const rawTx of bundle) expect(facts).toContainEqual(spendFact(rawTx))
      // The coins they spend left selection, and the refresh above listed the successors.
      for (const coin of known) {
        expect(coins.get(coin.account, coin.nonce)?.state ?? 'gone').not.toBe('unspent')
        expect(coins.latestOf(coin.account)?.nonce).toBeGreaterThan(coin.nonce)
      }
      const after = coins.all()
      const calls = applied.mock.calls.length

      // Read again from the start: the same one sent message, nothing applied twice.
      const again = await read(other, other.alice)
      expect(again.messages.map(message => message.payloadDigest)).toEqual([sent.payloadDigest])
      expect(again.held).toEqual([])
      expect(applied).toHaveBeenCalledTimes(calls)
      expect(coins.all()).toEqual(after)
    })

    it('a paid sealed message whose note to self does not get through is still sent, and the note follows from the resend pass after a restart', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      routeByRecipient = true
      selfUnreachable = true
      const id = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c'
      // The message and its payment are out whatever happens to the note.
      const sent = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [{ type: 'text', text: 'note follows later' }],
        stampValue: STAMP,
        messageId: id,
        sealedSender: true,
      })
      expect(bobMailbox).toHaveLength(1)
      expect(addressed).toContain('self')
      expect(mailbox).toHaveLength(0)
      expect(
        warn.mock.calls.some(([text]) => String(text).includes('note to self for a sealed message')),
      ).toBe(true)
      // A restart: the owed note is in the durable record, not in memory.
      await one.alice.close()
      const reopened = (await one.chain.createWallet(roots(0))) as EvmChainWalletHandle
      ;(one as { alice: EvmChainWalletHandle }).alice = reopened
      installCanonicalDirectory(reopened, aliceDirectories.get(one)!)
      selfUnreachable = false
      addressed = []
      expect(
        await one.chain.directMessages.reconcileAttempts({
          wallet: reopened,
          payloadDigests: [sent.payloadDigest],
          maxPutAttempts: 2,
        }),
      ).toEqual({ [sent.payloadDigest]: 'delivered' })
      // Only notes to self went out; the original was not submitted again.
      expect(addressed.length).toBeGreaterThan(0)
      expect(addressed.every(to => to === 'self')).toBe(true)
      expect(bobMailbox).toHaveLength(1)
      // A further pass owes nothing more.
      const copies = mailbox.length
      await one.chain.directMessages.reconcileAttempts({
        wallet: reopened,
        payloadDigests: [sent.payloadDigest],
        maxPutAttempts: 2,
      })
      expect(mailbox).toHaveLength(copies)
      routeByRecipient = false
      // The fixture closes the wallet it opened; the reopened one is closed here.
      await reopened.close()
      const other = await otherDevice()
      const { messages, held } = await read(other, other.alice)
      expect(held).toEqual([])
      expect(messages).toEqual([
        expect.objectContaining({
          outbound: true,
          payloadDigest: sent.payloadDigest,
          messageId: id,
          items: [{ type: 'text', text: 'note follows later' }],
        }),
      ])
    })

    it('shows a free sealed message on the other device and a restore, and a repeat of it sends nothing new', async () => {
      routeByRecipient = true
      const id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
      const sent = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [{ type: 'text', text: 'sealed and free' }],
        stampValue: 0n,
        messageId: id,
        sealedSender: true,
      })
      expect(bobMailbox).toHaveLength(1)
      selfCopyOf(sent.payloadDigest)
      const requests = one.requests.length
      routeByRecipient = false
      const other = await otherDevice()
      for (let pass = 0; pass < 2; pass++) {
        const { messages, held, passed } = await read(other, other.alice)
        expect(held).toEqual([])
        expect(passed).toEqual([])
        expect(messages).toEqual([
          expect.objectContaining({
            outbound: true,
            payloadDigest: sent.payloadDigest,
            messageId: id,
            items: [{ type: 'text', text: 'sealed and free' }],
          }),
        ])
      }
      // A free note carries no spend.
      expect(applied).not.toHaveBeenCalled()
      expect(one.requests).toHaveLength(requests)
    })

    // Delivery to the recipient and the note to self are distinct facts: a note that does not
    // get through never turns a delivered message into a failed send.
    it.each([
      ['named', '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e'],
      ['unnamed', undefined],
    ] as const)(
      'a free sealed message (%s) whose note to self does not get through is reported delivered, and a later pass, after a restart, delivers the note',
      async (_kind, id) => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        routeByRecipient = true
        selfUnreachable = true
        const sent = await one.chain.directMessages.send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items: [{ type: 'text', text: 'note held back' }],
          stampValue: 0n,
          ...(id === undefined ? {} : { messageId: id }),
          sealedSender: true,
        })
        expect(sent.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(bobMailbox).toHaveLength(1)
        expect(mailbox).toHaveLength(0)
        expect(
          warn.mock.calls.some(([text]) =>
            String(text).includes('note to self for a sealed message'),
          ),
        ).toBe(true)
        // A restart: what is owed is in the durable record, not in memory.
        await one.alice.close()
        const reopened = (await one.chain.createWallet(roots(0))) as EvmChainWalletHandle
        ;(one as { alice: EvmChainWalletHandle }).alice = reopened
        installCanonicalDirectory(reopened, aliceDirectories.get(one)!)
        selfUnreachable = false
        addressed = []
        // Any reconcile pass sends what is owed; the original is not submitted again.
        await one.chain.directMessages.reconcileAttempts({
          wallet: reopened,
          payloadDigests: [],
        })
        expect(addressed).toEqual(['self'])
        expect(bobMailbox).toHaveLength(1)
        selfCopyOf(sent.payloadDigest)
        // Nothing more is owed.
        await one.chain.directMessages.reconcileAttempts({
          wallet: reopened,
          payloadDigests: [],
          maxPutAttempts: 2,
        })
        expect(addressed).toEqual(['self'])
        routeByRecipient = false
        await reopened.close()
        const other = await otherDevice()
        const { messages, held } = await read(other, other.alice)
        expect(held).toEqual([])
        expect(messages).toEqual([
          expect.objectContaining({
            outbound: true,
            payloadDigest: sent.payloadDigest,
            items: [{ type: 'text', text: 'note held back' }],
          }),
        ])
      },
    )

    // Each item is larger than the 64 KiB a note to self once allowed per frame, and the two
    // together larger than half a direct message (the frames once travelled as hex text).
    const largeItems = [
      { type: 'text' as const, text: 'a'.repeat(150_000) },
      { type: 'text' as const, text: 'b'.repeat(150_000) },
    ]
    it.each([
      ['free', 0n],
      ['paid', STAMP],
    ] as const)(
      'shows a %s sealed message with items over 64 KiB on the other device',
      async (_kind, stampValue) => {
        const warn = jest.spyOn(console, 'warn')
        routeByRecipient = true
        const id = '4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b'
        const sent = await one.chain.directMessages.send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items: largeItems,
          stampValue,
          messageId: id,
          sealedSender: true,
        })
        expect(bobMailbox).toHaveLength(1)
        // The note went out with the message: nothing is owed, nothing was retried.
        expect(
          one.chain.directMessages.selfCopyOf!({
            wallet: one.alice,
            payloadDigest: sent.payloadDigest,
          }),
        ).toBeUndefined()
        expect(
          warn.mock.calls.some(([text]) => String(text).includes('note to self')),
        ).toBe(false)
        routeByRecipient = false
        const other = await otherDevice()
        for (let pass = 0; pass < 2; pass++) {
          const { messages, held } = await read(other, other.alice)
          expect(held).toEqual([])
          expect(messages).toEqual([
            expect.objectContaining({
              outbound: true,
              payloadDigest: sent.payloadDigest,
              messageId: id,
              items: largeItems,
            }),
          ])
        }
      },
    )

    it.each([
      ['free', 0n],
      ['paid', STAMP],
    ] as const)(
      'shows a %s sealed message larger than the 512 KiB of a plugin item on the other device: its note to self is not held to that limit',
      async (_kind, stampValue) => {
        routeByRecipient = true
        // Once refused: the note to self, which holds the message and its own fields, was one
        // plugin item of at most 512 KiB. It now holds what a direct message carries.
        const items = [
          { type: 'text' as const, text: 'c'.repeat(262_144) },
          { type: 'text' as const, text: 'd'.repeat(262_144) },
        ]
        const sent = await one.chain.directMessages.send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items,
          stampValue,
          sealedSender: true,
        })
        expect(bobMailbox).toHaveLength(1)
        expect(addressed.filter(to => to === 'self').length).toBeGreaterThan(0)
        routeByRecipient = false
        const other = await otherDevice()
        const { messages, held } = await read(other, other.alice)
        expect(held).toEqual([])
        expect(messages).toEqual([
          expect.objectContaining({
            outbound: true,
            payloadDigest: sent.payloadDigest,
            items,
          }),
        ])
      },
    )

    it('seals and sends a free and a paid direct message of the largest size, more than 8 MiB, and refuses one byte more before anything is sent', async () => {
      routeByRecipient = true
      const envelopeOf = (record: InboxRecord): number => {
        const parsed = parseFrame(record.delivery)
        if (parsed.kind !== 'parsed' || parsed.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
          throw new Error('expected a delivery frame')
        const payload = parsed.typed.payloadFrame.typed
        if (payload?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD || payload.schemaVersion !== 2)
          throw new Error('expected a schema-2 payload')
        return payload.cryptoBoxEnvelope.length
      }
      // 33 text items (each at most 256 KiB); the envelope grows byte for byte with the text.
      const texts = (last: number) =>
        Array.from({ length: 33 }, (_, i) => ({
          type: 'text' as const,
          text: String.fromCharCode(97 + (i % 26)).repeat(i === 32 ? last : 254_000),
        }))
      const send = (items: MessageItem[], sealedSender = false, stampValue = 0n) =>
        one.chain.directMessages.send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items,
          stampValue,
          ...(sealedSender ? { sealedSender: true } : {}),
        })
      await send(texts(200_000))
      expect(bobMailbox).toHaveLength(1)
      const last = 200_000 + MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES - envelopeOf(bobMailbox[0])
      expect(last).toBeLessThanOrEqual(262_144)
      // The largest: its envelope is exactly the codec's limit and its delivery is over 8 MiB.
      await send(texts(last))
      expect(bobMailbox).toHaveLength(2)
      expect(envelopeOf(bobMailbox[1])).toBe(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES)
      expect(bobMailbox[1].delivery.length).toBeGreaterThan(8 * 1024 * 1024)
      // Paid, the same message goes through the stamp path and its journal too.
      await send(texts(last), false, STAMP)
      expect(bobMailbox).toHaveLength(3)
      expect(envelopeOf(bobMailbox[2])).toBe(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES)
      // One byte more is refused before anything is handed to the relay.
      const funded = mockFunded.length
      const over = await send(texts(last + 1)).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(over).toBeInstanceOf(FrankCodecError)
      expect(over).toMatchObject({ category: 'resource' })
      expect(isDirectMessageNotAttempted(over)).toBe(true)
      // Sealed, the same message cannot have a note to self: the note holds every item and its
      // own fields, so it is larger than the largest direct message. It is refused before
      // anything is sent (the largest sealed message is a little smaller; see the next test).
      const sealed = await send(texts(last), true).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(sealed).toBeInstanceOf(SealedSelfCopyTooLargeError)
      expect(isDirectMessageNotAttempted(sealed)).toBe(true)
      expect(bobMailbox).toHaveLength(3)
      expect(mockFunded).toHaveLength(funded)
    })

    it.each([
      ['free', 0n],
      ['paid', STAMP],
    ] as const)(
      'sends a %s sealed message of the largest size whose note to self fits, shows it on the other device, and refuses one byte more before anything is paid',
      async (kind, stampValue) => {
        routeByRecipient = true
        const envelopeOf = (record: InboxRecord): number => {
          const parsed = parseFrame(record.delivery)
          if (parsed.kind !== 'parsed' || parsed.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
            throw new Error('expected a delivery frame')
          const payload = parsed.typed.payloadFrame.typed
          if (payload?.type !== TYPE_RECIPIENT_ENCRYPTED_PAYLOAD || payload.schemaVersion !== 2)
            throw new Error('expected a schema-2 payload')
          return payload.cryptoBoxEnvelope.length
        }
        const texts = (last: number) =>
          Array.from({ length: 33 }, (_, i) => ({
            type: 'text' as const,
            text: String.fromCharCode(97 + (i % 26)).repeat(i === 32 ? last : 254_000),
          }))
        const send = (items: MessageItem[], stamp = 0n) =>
          one.chain.directMessages.send({
            wallet: one.alice,
            recipient: one.bob.identity.address,
            items,
            stampValue: stamp,
            sealedSender: true,
          })
        // A free sealed probe of the same shape: the sealed original and its note to self each
        // grow byte for byte with the text. The note, which holds the original's items and its
        // own fields, is the larger, so it is what bounds a sealed message.
        await send(texts(200_000))
        expect(bobMailbox).toHaveLength(1)
        expect(mailbox).toHaveLength(1)
        const original = envelopeOf(bobMailbox[0])
        const note = envelopeOf(mailbox[0])
        expect(note).toBeGreaterThan(original)
        // Before it pays, the wallet builds the note with the facts it does not know yet at their
        // widest: the relay's time as a current time (this test's relay answers 1234) and, for a
        // paid send, a stamp of the largest amount. The note it sends is smaller by that much.
        const outbox = {
          type: 'outbox-message' as const,
          payloadDigest: '00'.repeat(32),
          recipientAddress: one.bob.identity.address.raw,
          sentAt: bobMailbox[0].timestampMs,
        }
        const size = (fields: Partial<typeof outbox> & { stampValueWei?: string }) =>
          outboxMessageCodec.encode({ ...outbox, ...fields }).length
        const widest = size({
          sentAt: Date.now(),
          ...(kind === 'paid' ? { stampValueWei: ((1n << 256n) - 1n).toString() } : {}),
        })
        const slack = widest - size({})
        const largest = 200_000 + MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES - note - slack
        bobMailbox.length = 0
        mailbox.length = 0
        addressed = []
        const sent = await send(texts(largest), stampValue)
        expect(bobMailbox).toHaveLength(1)
        expect(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES - envelopeOf(bobMailbox[0])).toBe(note - original + slack)
        expect(bobMailbox[0].delivery.length).toBeGreaterThan(8 * 1024 * 1024)
        // The note to self of the largest sealed message is the one large record in the
        // account's mailbox (a paid send also writes its spends and its coins' notes).
        const notes = mailbox.map(envelopeOf)
        if (kind === 'free') expect(notes).toHaveLength(1)
        expect(notes.filter(size => size > 1_000_000)).toHaveLength(1)
        const largestNote = Math.max(...notes)
        // Exactly the largest envelope, less what the wallet counted at its widest; a paid note
        // holds its settled stamp.
        const settledStamp =
          kind === 'paid' ? size({ stampValueWei: sent.stampValueWei.toString() }) - size({}) : 0
        expect(largestNote).toBe(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES - slack + settledStamp)
        expect(
          one.chain.directMessages.selfCopyOf!({
            wallet: one.alice,
            payloadDigest: sent.payloadDigest,
          }),
        ).toBeUndefined()
        // One byte more: refused before anything is paid or handed to the relay.
        const funded = mockFunded.length
        const broadcasts = providerBroadcasts.length
        addressed = []
        const over = await send(texts(largest + 1), stampValue).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(over).toBeInstanceOf(SealedSelfCopyTooLargeError)
        expect(isDirectMessageNotAttempted(over)).toBe(true)
        // Nothing went to the recipient, and no second note to self (the paid send's own small
        // notes may still be on their way to the account's mailbox).
        expect(addressed).not.toContain('peer')
        expect(bobMailbox).toHaveLength(1)
        expect(mailbox.map(envelopeOf).filter(size => size > 1_000_000)).toHaveLength(1)
        expect(mockFunded).toHaveLength(funded)
        expect(providerBroadcasts).toHaveLength(broadcasts)
        console.log(
          `largest ${kind} sealed message: 33 text items, ${32 * 254_000 + largest} bytes of text; ` +
            `original envelope ${envelopeOf(bobMailbox[0])}, note envelope ${largestNote} (limit ${MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES}, counted at the widest: ${slack} bytes more)`,
        )
        // The other device reads the note and shows the whole message as sent.
        routeByRecipient = false
        const other = await otherDevice()
        const { messages, held } = await read(other, other.alice)
        expect(held).toEqual([])
        expect(messages).toEqual([
          expect.objectContaining({
            outbound: true,
            payloadDigest: sent.payloadDigest,
            items: texts(largest),
          }),
        ])
      },
    )

    it.each([
      ['free', 0n],
      ['paid', STAMP],
    ] as const)(
      'a %s sealed message whose note to self can never be sent is delivered, says so, and the note is not retried',
      async (_kind, stampValue) => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        routeByRecipient = true
        // The note cannot be encoded once the message is out (the check before the send passed).
        const encode = wire.encodeItemFrames
        jest.spyOn(wire, 'encodeItemFrames').mockImplementation((registry, items, addressing) => {
          if (addressed.includes('peer') && items[0]?.type === 'outbox-message')
            throw new MessageItemEncodeError('outbox-message', 'never encodable')
          return encode(registry, items, addressing)
        })
        const sent = await one.chain.directMessages.send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items: [{ type: 'text', text: 'no note for this one' }],
          stampValue,
          sealedSender: true,
        })
        expect(bobMailbox).toHaveLength(1)
        const failed = {
          state: 'failed',
          reason: 'never encodable',
        }
        expect(
          one.chain.directMessages.selfCopyOf!({
            wallet: one.alice,
            payloadDigest: sent.payloadDigest,
          }),
        ).toEqual(failed)
        expect(
          error.mock.calls.filter(([text]) => String(text).includes('can never be sent')),
        ).toHaveLength(1)
        expect(
          warn.mock.calls.some(([text]) => String(text).includes('it is sent again later')),
        ).toBe(false)
        // Later passes, also after a restart, do not try it again; the failure stays recorded.
        await one.alice.close()
        const reopened = (await one.chain.createWallet(roots(0))) as EvmChainWalletHandle
        ;(one as { alice: EvmChainWalletHandle }).alice = reopened
        installCanonicalDirectory(reopened, aliceDirectories.get(one)!)
        addressed = []
        for (let pass = 0; pass < 2; pass++)
          await one.chain.directMessages.reconcileAttempts({
            wallet: reopened,
            payloadDigests: [sent.payloadDigest],
            maxPutAttempts: 2,
          })
        expect(addressed).not.toContain('self')
        expect(
          one.chain.directMessages.selfCopyOf!({
            wallet: reopened,
            payloadDigest: sent.payloadDigest,
          }),
        ).toEqual(failed)
        expect(
          error.mock.calls.filter(([text]) => String(text).includes('can never be sent')),
        ).toHaveLength(1)
        // The fixture closes the wallet it opened; the reopened one is closed here.
        await reopened.close()
        await otherDevice()
      },
    )
  })

  it('delivers a Sepolia spend through the primary mailbox to the other device’s Sepolia owner', async () => {
    const config: EvmChainConfig = {
      networkId: 'ethereum-sepolia',
      rpcChain: 'ethereum-sepolia',
      chainIdentifier: 'ethereum-sepolia',
      chainId: 11155111,
      networkTag: 'SEPO',
      relayBaseUrl: 'http://127.0.0.1:1',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 1,
      walletStorageLocation: false,
      transactionSetPolicy: (): EvmTransactionSetPolicy => ({
        sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
        gasPriceWei: 3n,
        paymentGasLimit: () => 21_000n,
        changeGasLimit: 21_000n,
        paymentFeeIsExact: true,
        dustWei: 21_000n,
        radix: 2,
        jitterBps: 1_500,
        maxChangeOutputs: 20,
        head: 100,
      }),
      emitWalletSync: (item, record, messageId) => one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.alice.identity.address,
        items: record ? [item, record] : [item],
        stampValue: 0n,
        messageId,
      }).then(() => undefined),
    }
    const sendingChain = createEvmChain(config)
    const sender = await sendingChain.createWallet(roots(0)) as EvmChainWalletHandle
    try {
      const [source] = sender.pool.ensureSize(1)
      await sender.pool.flush()
      mockBalances.set(source.address.toLowerCase(), 10n ** 17n)
      minesNativeTransfers(sender)
      one.setMailbox(mailbox)
      const sent = await sender.sendLegacy!({
        recipient: { raw: one.bob.identity.address.raw },
        value: 1_000n,
      })
      await sender.reobserveNativeOperations!()
      await sender.flushNativeSync!()
      // One note per transaction of the transfer's set: the payment and each change split.
      const operation = await operationForTransaction(sender, sent.txHash)
      expect(mailbox).toHaveLength(operation.members.length)
      expect(operation.members.map(member => member.signed!.transactionHash)).toContain(sent.txHash)
      one.setMailbox(undefined)
      await sender.close()
      const other = await otherDevice()
      const receivingChain = createEvmChain({ ...config, emitWalletSync: async () => undefined })
      const target = await receivingChain.createWallet(roots(0)) as EvmChainWalletHandle
      try {
        const [counterpart] = target.pool.ensureSize(1)
        expect(counterpart.address.toLowerCase()).toBe(source.address.toLowerCase())
        await expect(read(other, other.alice, 0, async () => {
          throw new Error('secondary owner temporarily unavailable')
        })).rejects.toThrow('secondary owner temporarily unavailable')
        expect(applied).not.toHaveBeenCalled()
        const readResult = await read(other, other.alice, 0, item =>
          syncDispatch.applyWalletSyncItem(target, item).then(() => undefined),
        )
        expect(readResult.messages).toEqual([])
        expect(readResult.held).toEqual([])
        expect(applied).toHaveBeenCalledWith(target, expect.objectContaining({
          chainIdentifier: 'ethereum-sepolia', txHash: sent.txHash,
        }))
        expect(target.pool.getRecord(counterpart.index)?.status).not.toBe('available')
      } finally {
        await target.close()
      }
    } finally {
      await sender.close()
    }
  })

  it('is refused, before anything is paid, in a message to anyone else', async () => {
    one.setMailbox(bobMailbox)
    const error = await one.chain.directMessages
      .send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [note()],
        stampValue: STAMP,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(wire.MessageItemNotCarriedError)
    expect(isDirectMessageNotAttempted(error)).toBe(true)
    expect(one.requests).toHaveLength(0)
    expect(mockFunded).toHaveLength(0)
    expect(bobMailbox).toHaveLength(0)
  })

  it('from a different sender arrives unsupported and reaches no wallet state', async () => {
    // A peer running other code: its sender writes the frame this wallet's sender refuses.
    const forged = encodePluginMessageItem({
      itemType: 'wallet-sync',
      data: registry.encodeItem(note()).bytes,
    })
    const peer = jest
      .spyOn(wire, 'encodeItemFrames')
      .mockReturnValueOnce([forged, relayDm.directMessageText('synced')])
    one.setMailbox(mailbox)
    const sent = await one.chain.directMessages.send({
      wallet: one.bob,
      recipient: one.alice.identity.address,
      items: [{ type: 'text', text: 'placeholder' }],
      stampValue: STAMP,
    })
    one.setMailbox(undefined)
    peer.mockRestore()

    const { messages, passed, held } = await read(one, one.alice)
    expect(passed).toEqual([])
    expect(held).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0].payloadDigest).toBe(sent.payloadDigest)
    expect(messages[0].senderAddress.raw).toBe(one.bob.identity.address.raw)
    expect(messages[0].items).toEqual([
      {
        type: 'unsupported',
        reason: 'unknown-type',
        itemType: 'wallet-sync',
        frameType: 27,
        frame: toHex(forged),
      },
      { type: 'text', text: 'synced' },
    ] satisfies MessageItem[])
    expect(applied).not.toHaveBeenCalled()
  })

  describe('a received note that cannot be applied', () => {
    /** One note in the account's mailbox, and the account opened on the other device. */
    async function delivered() {
      one.setMailbox(mailbox)
      const sent = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.alice.identity.address,
        items: [note()],
        stampValue: 0n,
      })
      one.setMailbox(undefined)
      const other = await otherDevice()
      return { other, row: [mailbox[0].timestampMs, sent.payloadDigest] }
    }
    let warn: jest.SpyInstance
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    const warnings = () =>
      warn.mock.calls.filter(([text]) => String(text).includes('[wallet-sync]'))

    it.each([
      [
        'another chain',
        () =>
          new syncDispatch.WalletSyncItemRejectedError(
            'chain-mismatch',
            'monad-testnet',
            'ethereum-sepolia',
          ),
      ],
      [
        'a row of which only its terminal checkpoint remains',
        () =>
          new SubAccountSpendRefusedError(
            'held',
            0,
            'only a compacted terminal checkpoint remains',
          ),
      ],
      [
        'a row that already carries another spend',
        () =>
          new SubAccountSpendRefusedError(
            'held',
            0,
            'row is spent with another spend checkpoint',
          ),
      ],
      [
        'a transaction that does not agree with the note',
        () => new SubAccountSpendRefusedError('inconsistent-item', 0, 'x'),
      ],
      [
        'a transaction that is not this wallet\'s to record',
        () => new EvmInputAdmissionError('invalid-provenance'),
      ],
    ])(
      'refused for good (%s): passed at once with one warning, and not tried again',
      async (_why, refusal) => {
        const { other, row } = await delivered()
        applied.mockRejectedValue(refusal())
        for (let pass = 0; pass < 3; pass++) {
          const result = await read(other, other.alice)
          expect(result.messages).toEqual([])
          expect(result.held).toEqual([])
          expect(result.passed).toEqual([row])
        }
        expect(applied).toHaveBeenCalledTimes(1)
        expect(warnings()).toHaveLength(1)
      },
    )

    it('held for now: kept in the replay window and tried again, applied when it can be', async () => {
      const { other, row } = await delivered()
      applied.mockRejectedValueOnce(
        new SubAccountSpendRefusedError('held', 0, 'row is in-use'),
      )
      applied.mockRejectedValueOnce(
        new EvmInputAdmissionError('conflicting-authorization'),
      )
      for (let pass = 0; pass < 2; pass++) {
        const waiting = await read(other, other.alice)
        expect(waiting.messages).toEqual([])
        expect(waiting.passed).toEqual([])
        expect(waiting.held).toEqual([row[0]])
      }
      const done = await read(other, other.alice)
      expect(done.held).toEqual([])
      expect(done.passed).toEqual([row])
      expect(applied).toHaveBeenCalledTimes(3)
      expect(warnings()).toHaveLength(0)
    })

    it('still failing after the retry window: passed, with one warning, so the cursor is not held for good', async () => {
      const { other, row } = await delivered()
      applied.mockRejectedValue(
        new SubAccountSpendRefusedError('held', 0, 'row is in-use'),
      )
      const started = Date.now()
      const now = jest.spyOn(Date, 'now').mockReturnValue(started)
      expect((await read(other, other.alice)).held).toEqual([row[0]])
      now.mockReturnValue(started + SELF_NOTE_RETRY_MS - 1)
      expect((await read(other, other.alice)).held).toEqual([row[0]])
      expect(warnings()).toHaveLength(0)
      now.mockReturnValue(started + SELF_NOTE_RETRY_MS)
      for (let pass = 0; pass < 2; pass++) {
        const result = await read(other, other.alice)
        expect(result.held).toEqual([])
        expect(result.passed).toEqual([row])
      }
      expect(applied).toHaveBeenCalledTimes(3)
      expect(warnings()).toHaveLength(1)
    })
  })

  // The app's Send page sends through `nativeTransfers.sendLegacy`, which waits to see the
  // transfer included. Afterwards the wallet tells the account's other devices with a free note
  // to itself. The send does not wait for that note and never fails for it.
  describe('after a native send', () => {
    const send = (f: Fixture) =>
      f.chain.nativeTransfers.sendLegacy!({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        value: 1_000n,
      })
    /** What the app's Wallet and Send pages read (`inspectNativeTransferOperations`). */
    const status = async (txHash: string) => {
      const row = await operationForTransaction(one.alice, txHash)
      expect(row.transactionSetStages?.some(stage => stage.legacy)).toBe(true)
      return {
        row,
        ...summarizeEvmNativeOperation(
          row,
          one.alice.nativeOperationSyncFailed!(row.operationId),
        ),
      }
    }
    /** The note is sent after the send has resolved: wait for what it leaves behind. */
    const until = async (done: () => Promise<boolean>) => {
      for (let waited = 0; !(await done()) && waited < 10_000; waited += 10)
        await new Promise(resolve => setTimeout(resolve, 10))
      expect(await done()).toBe(true)
    }
    const nothingPaid = async (txHash: string) => {
      expect(mockFunded).toHaveLength(0)
      expect(providerBroadcasts).toHaveLength((await status(txHash)).row.members.length)
      expect(
        await one.chain.directMessages.unattributedAttempts({
          wallet: one.alice,
          knownDigests: [],
        }),
      ).toEqual([])
    }

    it('free notes for every signed movement reach the relay and the other device applies them once', async () => {
      minesNativeTransfers(one.alice)
      one.setMailbox(mailbox)
      const sent = await send(one)
      // Force completion before reading status: sharing may already have archived the graph.
      await expect(one.alice.flushNativeSync!()).resolves.toEqual([])
      expect(one.alice.getNativeOperations!().some(row =>
        row.members.some(member => member.signed?.transactionHash === sent.txHash),
      )).toBe(false)
      expect((await status(sent.txHash)).payment).toBe('included')
      await until(async () => (await status(sent.txHash)).sharing === 'shared')
      const { row } = await status(sent.txHash)
      const payments = row.members.filter(member => member.transactionSet?.role === 'payment')
      expect(payments).toHaveLength(1)
      expect(sent.txHash).toBe(payments[0].signed!.transactionHash)
      expect(row.members.some(member => member.transactionSet?.role === 'change')).toBe(true)
      expect(row.members.every(member => member.observation.state === 'included-success')).toBe(true)
      // One free self-note per original signed member, including every owned change movement.
      expect(one.requests).toHaveLength(row.members.length)
      expect(mailbox).toHaveLength(row.members.length)
      for (const encoded of one.requests) {
        const request = restoreCanonicalRequest(encoded)
        expect(request.parts.transactions).toEqual([])
        expect(request.identity.recipient).toBe(
          one.alice.identity.address.raw.toLowerCase(),
        )
        const delivery = parseFrame(request.parts.delivery)
        if (delivery.kind !== 'parsed' || delivery.typed?.type !== TYPE_DIRECT_MESSAGE_DELIVERY)
          throw new Error('not a delivery')
        expect(delivery.schemaVersion).toBe(2)
        expect(delivery.typed.payments).toEqual([])
      }
      await nothingPaid(sent.txHash)
      // This device recorded its own spend in the send; the note is for the others.
      expect(applied).not.toHaveBeenCalled()
      // Asking again sends nothing more.
      await one.alice.resumeLegacySend!(row.operationId)
      await one.alice.resumeNativeOperation!(row.operationId)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(one.requests).toHaveLength(row.members.length)

      one.setMailbox(undefined)
      const other = await otherDevice()
      const first = await read(other, other.alice)
      expect(first.messages).toEqual([])
      expect(applied).toHaveBeenCalledTimes(row.members.length)
      expect(applied.mock.calls.every(([wallet]) => wallet === other.alice)).toBe(true)
      expect(applied.mock.calls.map(([, item]) => ({
        type: item.type, chainIdentifier: item.chainIdentifier, txHash: item.txHash, rawTx: item.rawTx,
      }))).toEqual(row.members.map(member => ({
        type: 'wallet-sync', chainIdentifier: 'monad-testnet',
        txHash: member.signed!.transactionHash, rawTx: member.signed!.rawTransaction,
      })))
      // Applied, not merely passed: the other device now has the spend on record.
      for (const result of applied.mock.results) await expect(result.value).resolves.toBeDefined()
      expect(first.held).toEqual([])
      expect(first.passed).toEqual(mailbox.map(record => [record.timestampMs, expect.any(String)]))
      // Reading it again applies nothing more.
      await read(other, other.alice)
      expect(applied).toHaveBeenCalledTimes(row.members.length)
    })

    it('a wallet whose only money is at its identity address sends it natively', async () => {
      minesNativeTransfers(one.alice)
      const main = (await one.alice.getReceiveAddress()).raw.toLowerCase()
      const identity = one.alice.identity.address.raw.toLowerCase()
      mockBalances.set(main, 0n)
      mockBalances.set(identity, 10n ** 17n)
      const sent = await send(one)
      expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      const row = await operationForTransaction(one.alice, sent.txHash)
      expect(summarizeEvmNativeOperation(row).payment).toBe('included')
      expect(row.members.length).toBeGreaterThan(1)
      expect(row.members.every(member => Transaction.from(member.signed!.rawTransaction).from!.toLowerCase() === identity)).toBe(true)
      expect(row.members.filter(member => member.transactionSet?.role === 'payment')).toHaveLength(1)
      expect(row.members.every(member => member.observation.state === 'included-success')).toBe(true)
      expect(mockBalances.get(main)).toBe(0n)
    })

    it('resolves with the relay down and a paid chat message unresolved; the note is sent on a later flush, and neither holds the other', async () => {
      minesNativeTransfers(one.alice)
      // Route by the signed request recipient, including self-notes emitted during recovery.
      routeByRecipient = true
      // A chat message whose delivery is not known, paid from a funded single-use account. (One
      // paid from the main account holds that account until the chain shows its payment, and a
      // native send from it waits for that.)
      const [stampAccount] = one.alice.pool.ensureSize(1)
      await one.alice.pool.flush()
      mockBalances.set(stampAccount.address.toLowerCase(), STAMP + 63_000n)
      one.setMailbox(bobMailbox)
      one.setPhase('fail')
      const chat = await one.chain.directMessages
        .send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items: [{ type: 'text', text: 'hello' }],
          stampValue: STAMP,
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(chat).toBeInstanceOf(Error)
      const [chatOperation] = one.alice.getNativeOperations!()
      expect(chatOperation).toBeDefined()
      const chatBytes = chatOperation.members.map(member => member.signed!.rawTransaction)
      const funded = mockFunded.length
      // Relay still down: the send resolves on inclusion, and says the note did not get through.
      const sent = await send(one)
      expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      const nativeStatus = await status(sent.txHash)
      expect(nativeStatus.payment).toBe('included')
      const nativeOperationId = nativeStatus.row.operationId
      const nativeBytes = nativeStatus.row.members.map(member => member.signed!.rawTransaction)
      expect(nativeOperationId).not.toBe(chatOperation.operationId)
      expect(one.alice.getNativeOperations!().find(row => row.operationId === chatOperation.operationId)!.members.map(member => member.signed!.rawTransaction)).toEqual(chatBytes)
      await until(async () => (await status(sent.txHash)).sharing === 'failed')
      expect((await status(sent.txHash)).payment).toBe('included')
      expect(mockFunded).toHaveLength(funded)
      expect(mailbox).toHaveLength(0)

      // The relay is back. A later flush shares settled movements; chat delivery stays unresolved.
      one.setPhase('delivered')
      one.setMailbox(mailbox)
      await one.alice.resumeLegacySend!(nativeOperationId)
      await until(async () => (await status(sent.txHash)).sharing === 'shared')
      // The unresolved chat's payment can settle before delivery and also needs a self-note.
      // Flush both original graphs and account for every signed member, without paying again.
      await expect(one.alice.flushNativeSync!()).resolves.toEqual([])
      const sharedOperations = await Promise.all([chatOperation.operationId, nativeOperationId]
        .map(id => one.alice.readNativeOperation!(id)))
      const sharedMembers = sharedOperations.flatMap(row => row!.members)
      expect(sharedMembers.every(member => member.syncApplied)).toBe(true)
      expect(sharedOperations[0]!.members.map(member => member.signed!.rawTransaction)).toEqual(chatBytes)
      expect(sharedOperations[1]!.members.map(member => member.signed!.rawTransaction)).toEqual(nativeBytes)
      expect(mailbox).toHaveLength(sharedMembers.length)
      expect(new Set(mailbox.map(record => record.submissionIdentity)).size).toBe(sharedMembers.length)
      expect(bobMailbox).toHaveLength(0)
      expect(mockFunded).toHaveLength(funded)
      const noted = parseFrame(mailbox[0].delivery)
      expect(noted.kind === 'parsed' && noted.typed?.type === TYPE_DIRECT_MESSAGE_DELIVERY && noted.typed.payments).toEqual([])

      // The unresolved chat message is delivered as it was, and the next one goes out.
      one.setMailbox(bobMailbox)
      const nextMessageId = '00000000-0000-4000-8000-000000000043'
      const next = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        messageId: nextMessageId,
        items: [{ type: 'text', text: 'again' }],
        stampValue: STAMP,
      })
      // Recovery of the older message may complete independently during the new send.
      expect(bobMailbox.length).toBeGreaterThanOrEqual(1)
      expect(bobMailbox.length).toBeLessThanOrEqual(2)
      await one.chain.directMessages.reconcileAttempts({
        wallet: one.alice,
        payloadDigests: [],
      })
      expect(bobMailbox).toHaveLength(2)
      expect(new Set(bobMailbox.map(record => record.submissionIdentity)).size).toBe(2)
      for (const record of bobMailbox) {
        const request = one.requests.map(restoreCanonicalRequest).find(request =>
          request.identity.submission_identity === record.submissionIdentity)!
        expect(request.identity.recipient).toBe(one.bob.identity.address.raw.toLowerCase())
        expect(request.parts.transactions.length).toBeGreaterThan(0)
      }
      await expect(one.alice.flushNativeSync!()).resolves.toEqual([])
      // Successful sharing retires active rows. Resolve the three original operations from
      // their immutable history, rather than treating an empty active queue as no payment.
      const history = await one.alice.getNativeOperationHistory!({ limit: 100 })
      expect(history.next).toBeUndefined()
      expect(history.operations).toHaveLength(3)
      const nextOperation = history.operations.find(row =>
        row.preparationId === `evm-transaction-set:stamp-${nextMessageId.replace(/-/g, '')}`,
      )!
      expect(nextOperation).toBeDefined()
      const operationIds = [chatOperation.operationId, nativeOperationId, nextOperation.operationId]
      expect(new Set(history.operations.map(row => row.operationId))).toEqual(new Set(operationIds))
      const operations = await Promise.all(operationIds.map(id => one.alice.readNativeOperation!(id)))
      expect(operations.every(row => row !== undefined)).toBe(true)
      expect(operations[0]!.members.map(member => member.signed!.rawTransaction)).toEqual(chatBytes)
      expect(operations[1]!.members.map(member => member.signed!.rawTransaction)).toEqual(nativeBytes)
      expect(operations[2]!.members.filter(member => member.transactionSet?.role === 'payment')
        .map(member => member.signed!.transactionHash)).toEqual(next.stampPayments.map(payment => payment.txHash))
      const members = operations.flatMap(row => row!.members)
      expect(members.every(member => member.observation.state === 'included-success')).toBe(true)
      expect(new Set(members.map(member => member.signed!.transactionHash)).size).toBe(members.length)
      expect(new Set(mailbox.map(record => record.submissionIdentity)).size).toBe(members.length)
      expect(members.every(member => member.syncApplied)).toBe(true)
      expect(mailbox).toHaveLength(members.length)
      const submissions = one.requests.length
      const broadcasts = providerBroadcasts.length
      // Repeated retirement/recovery must neither pay again nor duplicate self-notes.
      for (const operationId of operationIds) await one.alice.resumeNativeOperation!(operationId)
      await expect(one.alice.flushNativeSync!()).resolves.toEqual([])
      expect(one.requests).toHaveLength(submissions)
      expect(providerBroadcasts).toHaveLength(broadcasts)
      expect(mailbox).toHaveLength(members.length)
      const other = await otherDevice()
      one.setMailbox(undefined)
      const first = await read(other, other.alice)
      expect(first.held).toEqual([])
      expect(first.messages).toEqual([])
      expect(applied).toHaveBeenCalledTimes(members.length)
      expect(applied.mock.calls.map(([, item]) => item.rawTx).sort())
        .toEqual(members.map(member => member.signed!.rawTransaction).sort())
      expect(applied.mock.calls.map(([, item]) => item.txHash)).toContain(sent.txHash)
      for (const result of applied.mock.results) await expect(result.value).resolves.toBeDefined()
      await read(other, other.alice)
      expect(applied).toHaveBeenCalledTimes(members.length)
    })
  })
})

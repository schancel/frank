/**
 * Two devices of one account: only the one its user acts on starts automatic signing work.
 *
 * Each "device" is its own copy of the app's modules (chat store, active-device store, the
 * reconciliation tick), with its own store and disk; nothing is shared but the account. A device
 * says it is active with a free note to self carrying a `device-claim` item. The note is taken at
 * the wallet's send call (the one seam stubbed here) and handed, as the mailbox row it becomes,
 * to the devices' real chat stores, which give it to their active-device stores.
 *
 * The wallet is a stand-in that counts what the tick asks of it: `maintainCoins` (background coin
 * maintenance, which signs new merges) and `reobserveNativeOperations` (which resubmits the
 * wallet's own already signed sets). Plain `node` environment; see `chats.jest.test.ts`'s header.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globals = global as any
const standIn = { hasFocus: () => true, visibilityState: 'visible' }
globals.document = standIn

import { createHash } from 'crypto'
import type { WalletHandle } from '@frank/wallet/chain'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageItem, MessageWrapper } from '@frank/cashweb/types/messages'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (_row: MessageWrapper) => undefined,
    deleteMessage: async () => undefined,
    suppressAndDelete: async () => undefined,
    suppressedRelayReceipts: async () => new Set<string>(),
    quarantineRelayReceipts: async () => undefined,
    mostRecentMessageTime: async () => 0,
    relayCursor: async () => 0,
    getIterator: async function* () {
      /* An empty disk. */
    },
    financialEnvelopeBindings: async () => [],
    bindFinancialEnvelope: async () => undefined,
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../accounts/evm-wallets', () => ({
  openEvmWallet: jest.fn(),
  peekOpenedEvmWallets: () => [],
  recoverSecondaryEvmWallets: async () => undefined,
}))

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'

/** A transaction set this wallet signed and authorized, not yet landed. */
interface PendingSet {
  kind: 'transaction-set'
  operationId: string
  submissionAuthorized: true
  cancelled: false
  members: { exposed: boolean; observation: { state: string } }[]
}

interface Device {
  name: string
  wallet: WalletHandle & {
    maintainCoins: jest.Mock
    reobserveNativeOperations: jest.Mock
  }
  journal: PendingSet[]
  leader: {
    isActiveMaster: boolean
    noteUserActivity(send: unknown): Promise<void>
    claimIdle(): Promise<void>
    resetForTesting(): void
  }
  /** The user acts on this device (a tap, a key, a send). */
  userActs: () => Promise<void>
  receive: (rows: ReceivedMessageWrapper[], own?: string) => Promise<void>
  /** The messages of each conversation the device shows. */
  shown: () => string[][]
  /** Sends a free automatic step to the peer, as the chat page does. */
  sendStep: (
    conversationId: string,
    stepKey: string,
    items: MessageItem[],
  ) => Promise<unknown>
  /** The messages of one conversation, as the device holds them. */
  messagesOf: (conversationId: string) => Array<{
    outbound: boolean
    status: string
    items: MessageItem[]
    payloadDigest: string
  }>
  /** The message ID an automatic step is sent under, as this device derives it. */
  automaticStepMessageId: (conversationId: string, stepKey: string) => string
  startReconciliation: () => { stop: () => void }
  gameSteps: (messages: unknown[]) => { key: string }[]
  saveDiceSecret: (rollId: string, secret: string) => void
  stopClaims: () => void
  dispose: () => void
}

let relayClock = 0
let mailbox: Array<{ by: string; row: ReceivedMessageWrapper }> = []
/** The copies of messages to the peer that the sending wallets hand the account's other
 * frontends (a note to self in place of the relay's outbox row), as the mailbox holds them. */
let sentCopies: Array<{ by: string; row: ReceivedMessageWrapper }> = []
const opened: Device[] = []
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** A note to self as the account's mailbox holds it. */
function noteRow(digest: string, items: MessageItem[]): ReceivedMessageWrapper {
  relayClock += 1
  return {
    outbound: false,
    senderAddress: ME,
    copartyAddress: ME,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index: digest,
    stampValue: 0,
    message: {
      outbound: false,
      status: 'confirmed',
      senderAddress: ME,
      destinationAddress: ME,
      items,
      serverTime: relayClock,
      receivedTime: relayClock,
      outpoints: [],
    },
  } as unknown as ReceivedMessageWrapper
}

/** A free automatic step sent from this account to the peer, as the peer's mailbox holds it. */
function stepCopy(
  conversationId: string,
  logicalMessageId: string,
  digest: string,
  time: number,
  contentDigest: string,
): ReceivedMessageWrapper {
  return {
    conversationId,
    outbound: false,
    senderAddress: ME,
    copartyAddress: ME,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index: digest,
    stampValue: 0,
    message: {
      conversationId,
      outbound: false,
      status: 'confirmed',
      senderAddress: ME,
      destinationAddress: PEER,
      items: [{ type: 'text', text: `content ${contentDigest}` }],
      serverTime: time,
      receivedTime: time,
      outpoints: [],
      logicalMessageId,
      contentDigest,
    },
  } as unknown as ReceivedMessageWrapper
}

/** Whether the tick asked this device's wallet to plan new merges. */
const startedMerges = (target: Device) =>
  target.wallet.maintainCoins.mock.calls.some(
    call => call[0]?.startNew === true,
  )
/** Whether the tick asked this device's wallet only to finish merges already signed. */
const finishedMerges = (target: Device) =>
  target.wallet.maintainCoins.mock.calls.some(
    call => call[0]?.startNew === false,
  )

function device(
  name: string,
  {
    foreground,
    firstRead,
  }: { foreground: boolean; firstRead?: Promise<unknown> },
): Device {
  let made: Device | undefined
  delete globals.document
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { createPinia, setActivePinia } = require('pinia')
    const { createApp } = require('vue')
    const chatsModule = require('./chats')
    const leaderModule = require('./leader')
    const adapter = require('../adapters/pinia-chain-adapter')
    const games = require('../utils/automatic-game-steps')
    const p2p = require('../utils/p2p-games')
    const { useContactStore } = require('./contacts')
    const { activeChain } = require('@frank/wallet/chain')
    const {
      conversationIdSalt,
    } = require('@frank/cashweb/relay/conversation-id')
    /* eslint-enable @typescript-eslint/no-var-requires */
    const pinia = createPinia()
    createApp({}).use(pinia)
    setActivePinia(pinia)
    chatsModule.setConversationIdSalt(
      conversationIdSalt(new Uint8Array(32).fill(0x11)),
    )
    Object.assign(useContactStore(pinia), { refresh: async () => undefined })
    const journal: PendingSet[] = []
    const wallet = {
      chainIdentifier: activeChain.chainIdentifier,
      identity: { address: { raw: ME }, displayAddress: ME },
      maintainCoins: jest.fn(async () => ({ outcome: 'idle' })),
      reobserveNativeOperations: jest.fn(async () => undefined),
      getNativeOperations: () => journal,
    } as unknown as Device['wallet']
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async (params: any) => {
        expect(params.wallet).toBe(wallet)
        if (params.recipient?.raw !== ME) {
          // A free message to the peer. Each wallet seals its own copy: its own digest.
          expect(params.stampValue ?? 0n).toBe(0n)
          relayClock += 1
          const digest = `dm-${name}-${relayClock}`
          const items = JSON.parse(JSON.stringify(params.items))
          sentCopies.push({
            by: name,
            row: {
              outbound: true,
              senderAddress: ME,
              copartyAddress: PEER,
              copartyPubKey: { toBuffer: () => new Uint8Array(33) },
              index: digest,
              stampValue: 0,
              conversationId: params.conversationId,
              message: {
                outbound: true,
                status: 'confirmed',
                senderAddress: ME,
                destinationAddress: PEER,
                items,
                serverTime: relayClock,
                receivedTime: relayClock,
                outpoints: [],
                stampValueWei: 0n,
                stampPayments: [],
                conversationId: params.conversationId,
                logicalMessageId: params.messageId,
                // The same content, whichever device sealed it.
                contentDigest: createHash('sha256')
                  .update(JSON.stringify(items))
                  .digest('hex'),
              },
            } as unknown as ReceivedMessageWrapper,
          })
          return {
            payloadDigest: digest,
            stampValueWei: 0n,
            stampPayments: [],
            preparationTxHashes: [],
          }
        }
        // A note to self, and free.
        expect(params.recipient).toEqual({ raw: ME })
        expect(params.stampValue).toBe(0n)
        const digest = `note-${hex(params.messageId as Uint8Array)}`
        mailbox.push({
          by: name,
          row: noteRow(digest, JSON.parse(JSON.stringify(params.items))),
        })
        return {
          payloadDigest: digest,
          stampValueWei: 0n,
          stampPayments: [],
          preparationTxHashes: [],
        }
      })
    jest
      .spyOn(activeChain.directMessages, 'unattributedAttempts')
      .mockResolvedValue([])
    jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({})
    const leader = leaderModule.useLeaderStore(pinia)
    globals.document = {
      hasFocus: () => foreground,
      visibilityState: foreground ? 'visible' : 'hidden',
    }
    const claims = leaderModule.startActiveDeviceClaims({ wallet, firstRead })
    made = {
      name,
      wallet,
      journal,
      leader,
      userActs: () =>
        leader.noteUserActivity(leaderModule.deviceClaimSender(wallet)),
      receive: async (rows, own = ME) => {
        setActivePinia(pinia)
        await chatsModule.useChatStore(pinia).receiveMessages(rows, own)
      },
      shown: () =>
        Object.values(
          chatsModule.useChatStore(pinia).conversations as Record<
            string,
            { messages: { payloadDigest: string }[] } | undefined
          >,
        )
          .filter(c => c !== undefined)
          .map(c => c!.messages.map(m => m.payloadDigest)),
      sendStep: (conversationId, stepKey, items) => {
        setActivePinia(pinia)
        return chatsModule.useChatStore(pinia).sendMessage({
          wallet,
          address: PEER,
          conversationId,
          items,
          stampValue: 0n,
          operationId: games.automaticStepOperationId(conversationId, stepKey),
        })
      },
      messagesOf: conversationId =>
        chatsModule.useChatStore(pinia).conversations[conversationId]
          ?.messages ?? [],
      automaticStepMessageId: (conversationId, stepKey) =>
        chatsModule.outgoingMessageId(
          games.automaticStepOperationId(conversationId, stepKey),
        ),
      startReconciliation: () => {
        setActivePinia(pinia)
        return adapter.startOutgoingReconciliation({
          wallet,
          intervalMs: 2,
          maxIntervalMs: 2,
          idleIntervalMs: 2,
          backgroundIntervalMs: 2,
        })
      },
      gameSteps: messages =>
        games.automaticGameSteps(messages, ME, PEER, {
          activeDevice: leader.isActiveMaster,
        }),
      saveDiceSecret: (rollId, secret) =>
        p2p.saveDiceSecret(ME, PEER, rollId, secret),
      stopClaims: () => claims.stop(),
      dispose: () => {
        claims.stop()
        // Closes this device's BroadcastChannel and cancels any claim retry.
        leader.resetForTesting()
        chatsModule.useChatStore(pinia).$dispose()
      },
    }
  })
  globals.document = standIn
  if (!made) throw new Error('device was not opened')
  opened.push(made)
  return made
}

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
}
const ticks = () => new Promise<void>(resolve => setTimeout(resolve, 40))

/** The relay hands every device the claims sent so far that it has not read yet. */
const read = new Map<string, number>()
async function sync(...devices: Device[]): Promise<void> {
  await settle()
  for (const each of devices) {
    const from = read.get(each.name) ?? 0
    const rows = mailbox.slice(from).map(entry => entry.row)
    read.set(each.name, mailbox.length)
    if (rows.length > 0) await each.receive(rows)
  }
}

const claimsIn = (rows: typeof mailbox) =>
  rows.flatMap(entry =>
    (entry.row.message.items ?? []).filter(
      (item: MessageItem) => item.type === 'device-claim',
    ),
  )

let running: Array<{ stop: () => void }> = []

beforeEach(() => {
  relayClock = 10_000
  mailbox = []
  sentCopies = []
  read.clear()
  running = []
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(console, 'debug').mockImplementation(() => undefined)
})

afterEach(async () => {
  for (const each of running) each.stop()
  for (const each of opened.splice(0)) each.dispose()
  await settle()
  jest.restoreAllMocks()
})

describe('the active device of an account', () => {
  it('is the one opened in the foreground; one hidden in the background claims nothing', async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    await sync(phone, laptop)
    expect(claimsIn(mailbox)).toHaveLength(1)
    expect(mailbox[0].by).toBe('phone')
    expect(phone.leader.isActiveMaster).toBe(true)
    expect(laptop.leader.isActiveMaster).toBe(false)
    // Acting again on the active device sends no second claim.
    await phone.userActs()
    await phone.userActs()
    await sync(phone, laptop)
    expect(claimsIn(mailbox)).toHaveLength(1)
  })

  it('alone consolidates coins, and the role passes over when the user acts on the other', async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    await sync(phone, laptop)
    running.push(phone.startReconciliation(), laptop.startReconciliation())
    await ticks()
    expect(startedMerges(phone)).toBe(true)
    expect(startedMerges(laptop)).toBe(false)
    // Both still finish what their own journals hold, merges already signed included.
    expect(finishedMerges(laptop)).toBe(true)
    expect(phone.wallet.reobserveNativeOperations).toHaveBeenCalled()
    expect(laptop.wallet.reobserveNativeOperations).toHaveBeenCalled()

    // The user picks up the laptop: one claim, read by both devices.
    await laptop.userActs()
    await sync(phone, laptop)
    expect(claimsIn(mailbox)).toHaveLength(2)
    expect(laptop.leader.isActiveMaster).toBe(true)
    expect(phone.leader.isActiveMaster).toBe(false)
    phone.wallet.maintainCoins.mockClear()
    laptop.wallet.maintainCoins.mockClear()
    await ticks()
    expect(startedMerges(laptop)).toBe(true)
    expect(startedMerges(phone)).toBe(false)

    // And back to the phone.
    await phone.userActs()
    await sync(phone, laptop)
    expect(phone.leader.isActiveMaster).toBe(true)
    expect(laptop.leader.isActiveMaster).toBe(false)
  })

  it('takes over even when its clock is behind the clock of the device that claimed before', async () => {
    const phone = device('phone', { foreground: true })
    await sync(phone)
    const laptop = device('laptop', { foreground: false })
    await sync(phone, laptop)
    const phoneClaimedAt = phone.leader as unknown as {
      masterClaimedAt: number
    }
    // The laptop's clock is an hour behind the phone's.
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValue(phoneClaimedAt.masterClaimedAt - 3_600_000)
    await laptop.userActs()
    now.mockRestore()
    await sync(phone, laptop)
    expect(laptop.leader.isActiveMaster).toBe(true)
    expect(phone.leader.isActiveMaster).toBe(false)
  })

  it('opened in the foreground, claims only after its first mailbox read, so it takes over from a claim stored there', async () => {
    const phone = device('phone', { foreground: true })
    await sync(phone)
    const stored = (phone.leader as unknown as { masterClaimedAt: number })
      .masterClaimedAt
    // The laptop's clock is an hour behind the phone's. It opens in the foreground; its first
    // mailbox read brings the phone's claim.
    const now = jest.spyOn(Date, 'now').mockReturnValue(stored - 3_600_000)
    let firstReadDone!: () => void
    const firstRead = new Promise<void>(resolve => {
      firstReadDone = resolve
    })
    const laptop = device('laptop', { foreground: true, firstRead })
    await settle()
    expect(mailbox.filter(entry => entry.by === 'laptop')).toEqual([])
    await sync(laptop)
    firstReadDone()
    await settle()
    await laptop.leader.claimIdle()
    now.mockRestore()
    expect(mailbox.filter(entry => entry.by === 'laptop')).toHaveLength(1)
    await sync(phone, laptop)
    expect(laptop.leader.isActiveMaster).toBe(true)
    expect(phone.leader.isActiveMaster).toBe(false)
  })

  it('alone sends a free automatic game step, which the other sends once the user acts on it', async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    await sync(phone, laptop)
    // The account is the dealer of a dice table; the peer rolled and lost, so the reveal is
    // free and is sent without asking. Both devices derive the same secret.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const {
      diceCommitment,
      diceRoll,
    } = require('@frank/wallet/message-item-plugins/dice/fair')
    /* eslint-enable @typescript-eslint/no-var-requires */
    const rollId = 'roll-1'
    const secret = 'ab'.repeat(32)
    phone.saveDiceSecret(rollId, secret)
    laptop.saveDiceSecret(rollId, secret)
    const commitment = diceCommitment(secret)
    const clientSeed = 'c3'.repeat(16)
    const messages = [
      {
        outbound: true,
        items: [{ type: 'dice', action: 'table', rollId, commitment }],
      },
      {
        outbound: false,
        items: [
          {
            type: 'dice',
            action: 'roll',
            rollId,
            commitment,
            clientSeed,
            target: Math.max(1, diceRoll(secret, clientSeed)),
            wagerWei: (10n ** 16n).toString(),
          },
        ],
      },
    ]
    expect(phone.gameSteps(messages).map(step => step.key)).toEqual([
      `dice:${rollId}`,
    ])
    expect(laptop.gameSteps(messages)).toEqual([])

    await laptop.userActs()
    await sync(phone, laptop)
    expect(phone.gameSteps(messages)).toEqual([])
    expect(laptop.gameSteps(messages).map(step => step.key)).toEqual([
      `dice:${rollId}`,
    ])
  })

  it('hands over in the middle of a pending send: the old device finishes it, the new one starts nothing for it', async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    await sync(phone, laptop)
    // The phone signed a send and handed it to the network; it has not landed.
    const pending: PendingSet = {
      kind: 'transaction-set',
      operationId: 'stamp-1',
      submissionAuthorized: true,
      cancelled: false,
      members: [{ exposed: true, observation: { state: 'pending' } }],
    }
    phone.journal.push(pending)
    running.push(phone.startReconciliation(), laptop.startReconciliation())
    await ticks()
    // While its own send is unfinished the phone merges nothing, active or not.
    expect(startedMerges(phone)).toBe(false)

    // Mid-send, the user picks up the laptop.
    await laptop.userActs()
    await sync(phone, laptop)
    expect(phone.leader.isActiveMaster).toBe(false)
    phone.wallet.reobserveNativeOperations.mockClear()
    await ticks()
    // The phone, no longer active, still offers its signed set again on every tick.
    expect(phone.wallet.reobserveNativeOperations).toHaveBeenCalled()

    // It lands. The phone, idle now, still starts no merge: it is not the active device.
    pending.members[0].observation.state = 'included-success'
    phone.journal.length = 0
    phone.wallet.maintainCoins.mockClear()
    laptop.wallet.maintainCoins.mockClear()
    await ticks()
    expect(startedMerges(phone)).toBe(false)
    expect(startedMerges(laptop)).toBe(true)
    // Nothing about the phone's send was ever sent from the laptop: only its claim.
    expect(
      mailbox
        .filter(entry => entry.by === 'laptop')
        .map(entry => entry.row.message.items),
    ).toEqual([[expect.objectContaining({ type: 'device-claim' })]])
  })

  it('sends an automatic step under a message ID derived from the step, so the copies two devices send are one message', async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    const peer = device('peer', { foreground: false })
    const conversationId = '11111111-1111-4111-8111-111111111111'
    const id = phone.automaticStepMessageId(conversationId, 'dice:roll-1')
    expect(laptop.automaticStepMessageId(conversationId, 'dice:roll-1')).toBe(
      id,
    )
    expect(
      phone.automaticStepMessageId(conversationId, 'dice:roll-2'),
    ).not.toBe(id)
    // During a hand-over both devices sent the reveal: two rows (two encryptions, two
    // digests) with the same message ID, from the same sender, in the same conversation.
    const item = { type: 'text', text: 'the reveal' } as MessageItem
    const copy = (digest: string, time: number) =>
      ({
        conversationId,
        outbound: false,
        senderAddress: ME,
        copartyAddress: ME,
        copartyPubKey: { toBuffer: () => new Uint8Array(33) },
        index: digest,
        stampValue: 0,
        message: {
          conversationId,
          outbound: false,
          status: 'confirmed',
          senderAddress: ME,
          destinationAddress: PEER,
          items: [item],
          serverTime: time,
          receivedTime: time,
          outpoints: [],
          logicalMessageId: id,
          contentDigest: 'cd'.repeat(32),
        },
      } as unknown as ReceivedMessageWrapper)
    await peer.receive([copy('a'.repeat(64), 20_000)], PEER)
    await peer.receive([copy('b'.repeat(64), 20_001)], PEER)
    expect(peer.shown().flat()).toEqual(['a'.repeat(64)])
    // Read again, alone or with the first, it is still one message.
    await peer.receive(
      [copy('a'.repeat(64), 20_000), copy('b'.repeat(64), 20_001)],
      PEER,
    )
    expect(peer.shown().flat()).toEqual(['a'.repeat(64)])
    // A copy that carries money is its own message.
    const paid = copy('c'.repeat(64), 20_002)
    Object.assign(paid, { stampValue: 1 })
    Object.assign(paid.message, { stampValueWei: 10n ** 15n })
    await peer.receive([paid], PEER)
    expect(peer.shown().flat()).toHaveLength(2)
  })

  it('keeps a copy of a step that carries any value: a stamp, UTXO outpoints or account-chain payments', async () => {
    const peer = device('peer', { foreground: false })
    const conversationId = '11111111-1111-4111-8111-111111111111'
    const id = peer.automaticStepMessageId(conversationId, 'dice:roll-1')
    const content = 'cd'.repeat(32)
    await peer.receive(
      [stepCopy(conversationId, id, 'a'.repeat(64), 20_000, content)],
      PEER,
    )
    const valued: Array<[string, (row: ReceivedMessageWrapper) => void]> = [
      ['b', row => Object.assign(row, { stampValue: 546 })],
      [
        'c',
        row =>
          Object.assign(row.message, {
            outpoints: [{ txid: 'ee'.repeat(32), outIdx: 1 }],
          }),
      ],
      ['d', row => Object.assign(row.message, { stampValueWei: 10n ** 15n })],
      [
        'e',
        row =>
          Object.assign(row.message, {
            stampPayments: [
              {
                txHash: '0x' + 'ff'.repeat(32),
                destinationAddress: PEER,
                valueWei: 10n ** 15n,
              },
            ],
          }),
      ],
    ]
    for (const [letter, addValue] of valued) {
      const row = stepCopy(
        conversationId,
        id,
        letter.repeat(64),
        20_001,
        content,
      )
      addValue(row)
      await peer.receive([row], PEER)
    }
    expect(peer.shown().flat()).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map(letter => letter.repeat(64)),
    )
    // A free copy is still dropped.
    await peer.receive(
      [stepCopy(conversationId, id, 'f'.repeat(64), 20_002, content)],
      PEER,
    )
    expect(peer.shown().flat()).toHaveLength(5)
  })

  it('keeps a return to earlier content: A, then B, then A again are three revisions, in one batch or in three', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111'
    const a = 'aa'.repeat(32)
    const b = 'bb'.repeat(32)
    const revisions = (id: string) => [
      stepCopy(conversationId, id, '1'.repeat(64), 20_000, a),
      stepCopy(conversationId, id, '2'.repeat(64), 20_001, b),
      stepCopy(conversationId, id, '3'.repeat(64), 20_002, a),
    ]
    const together = device('together', { foreground: false })
    const id = together.automaticStepMessageId(conversationId, 'edit:1')
    await together.receive(revisions(id), PEER)
    expect(together.shown().flat()).toEqual(
      ['1', '2', '3'].map(digit => digit.repeat(64)),
    )
    const apart = device('apart', { foreground: false })
    for (const row of revisions(id)) await apart.receive([row], PEER)
    expect(apart.shown().flat()).toEqual(
      ['1', '2', '3'].map(digit => digit.repeat(64)),
    )
    // A copy of the latest revision is still one message.
    await apart.receive(
      [stepCopy(conversationId, id, '4'.repeat(64), 20_003, a)],
      PEER,
    )
    expect(apart.shown().flat()).toHaveLength(3)
  })

  it("on the account that sent a step from both devices, each device reads the other's copy as the one message it sent", async () => {
    const phone = device('phone', { foreground: true })
    const laptop = device('laptop', { foreground: false })
    const tablet = device('tablet', { foreground: false })
    const conversationId = '11111111-1111-4111-8111-111111111111'
    const items = [{ type: 'text', text: 'the reveal' }] as MessageItem[]
    // Around a hand-over both devices sent the same step: one sealed message ID, two copies.
    await phone.sendStep(conversationId, 'dice:roll-1', items)
    await laptop.sendStep(conversationId, 'dice:roll-1', items)
    await settle()
    expect(sentCopies.map(copy => copy.by)).toEqual(['phone', 'laptop'])
    const [fromPhone, fromLaptop] = sentCopies.map(copy => copy.row)
    expect(fromPhone.message.logicalMessageId).toBe(
      phone.automaticStepMessageId(conversationId, 'dice:roll-1'),
    )
    expect(fromLaptop.message.logicalMessageId).toBe(
      fromPhone.message.logicalMessageId,
    )
    const sentOnce = (each: Device) => {
      const held = each.messagesOf(conversationId)
      expect(held).toHaveLength(1)
      expect(held[0].outbound).toBe(true)
      expect(held[0].status).toBe('confirmed')
      expect(held[0].items).toEqual(items)
    }
    // Each sender reads both copies: the phone its own first, the laptop the other's first
    // (its own copy has no content digest yet: its echo has not been read).
    await phone.receive([fromPhone])
    await phone.receive([fromLaptop])
    await laptop.receive([fromPhone])
    await laptop.receive([fromLaptop])
    for (const each of [phone, laptop]) sentOnce(each)
    // Read again (a reload, a second poll), still one message, sent.
    await phone.receive([fromLaptop, fromPhone])
    await laptop.receive([fromLaptop])
    for (const each of [phone, laptop]) sentOnce(each)
    // A third device of the account, which sent nothing, reads one message too.
    await tablet.receive([fromLaptop, fromPhone])
    sentOnce(tablet)

    // The next step, sent from both again, each device reading both copies in one read, the
    // other device's first.
    const next = [{ type: 'text', text: 'the next reveal' }] as MessageItem[]
    await phone.sendStep(conversationId, 'dice:roll-2', next)
    await laptop.sendStep(conversationId, 'dice:roll-2', next)
    await settle()
    const [nextFromPhone, nextFromLaptop] = sentCopies
      .slice(2)
      .map(copy => copy.row)
    await phone.receive([nextFromLaptop, nextFromPhone])
    await laptop.receive([nextFromPhone, nextFromLaptop])
    await tablet.receive([nextFromPhone, nextFromLaptop])
    for (const each of [phone, laptop, tablet]) {
      const held = each.messagesOf(conversationId)
      expect(held.map(message => message.items)).toEqual([items, next])
      expect(held.every(message => message.outbound)).toBe(true)
      expect(held.every(message => message.status === 'confirmed')).toBe(true)
    }
  })

  it('a claim in a row from anyone else is not read', async () => {
    const phone = device('phone', { foreground: true })
    await sync(phone)
    const forged = noteRow('forged', [
      {
        type: 'device-claim',
        instanceId: 'stranger',
        claimedAt: Date.now() + 60_000,
      } as MessageItem,
    ])
    Object.assign(forged, { senderAddress: PEER, copartyAddress: PEER })
    Object.assign(forged.message, { senderAddress: PEER })
    await phone.receive([forged])
    expect(phone.leader.isActiveMaster).toBe(true)
  })
})

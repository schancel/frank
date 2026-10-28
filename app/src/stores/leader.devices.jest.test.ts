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
  }
  /** The user acts on this device (a tap, a key, a send). */
  userActs: () => Promise<void>
  receive: (rows: ReceivedMessageWrapper[]) => Promise<void>
  startReconciliation: () => { stop: () => void }
  gameSteps: (messages: unknown[]) => { key: string }[]
  saveDiceSecret: (rollId: string, secret: string) => void
  stopClaims: () => void
  dispose: () => void
}

let relayClock = 0
let mailbox: Array<{ by: string; row: ReceivedMessageWrapper }> = []
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

function device(name: string, { foreground }: { foreground: boolean }): Device {
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
      identity: { address: { raw: ME } },
      maintainCoins: jest.fn(async () => ({ outcome: 'idle' })),
      reobserveNativeOperations: jest.fn(async () => undefined),
      getNativeOperations: () => journal,
    } as unknown as Device['wallet']
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async (params: any) => {
        // A note to self, and free.
        expect(params.wallet).toBe(wallet)
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
    const claims = leaderModule.startActiveDeviceClaims({ wallet })
    made = {
      name,
      wallet,
      journal,
      leader,
      userActs: () =>
        leader.noteUserActivity(leaderModule.deviceClaimSender(wallet)),
      receive: async rows => {
        setActivePinia(pinia)
        await chatsModule.useChatStore(pinia).receiveMessages(rows, ME)
      },
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
        chatsModule.useChatStore(pinia).$dispose()
      },
    }
  })
  globals.document = standIn
  if (!made) throw new Error('device was not opened')
  opened.push(made)
  return made
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
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
    expect(phone.wallet.maintainCoins).toHaveBeenCalled()
    expect(laptop.wallet.maintainCoins).not.toHaveBeenCalled()
    // Both still finish what their own journals hold.
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
    expect(laptop.wallet.maintainCoins).toHaveBeenCalled()
    expect(phone.wallet.maintainCoins).not.toHaveBeenCalled()

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
    expect(phone.wallet.maintainCoins).not.toHaveBeenCalled()

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
    expect(phone.wallet.maintainCoins).not.toHaveBeenCalled()
    expect(laptop.wallet.maintainCoins).toHaveBeenCalled()
    // Nothing about the phone's send was ever sent from the laptop: only its claim.
    expect(
      mailbox
        .filter(entry => entry.by === 'laptop')
        .map(entry => entry.row.message.items),
    ).toEqual([[expect.objectContaining({ type: 'device-claim' })]])
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

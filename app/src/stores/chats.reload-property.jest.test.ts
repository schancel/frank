/**
 * A reload shows what the session showed, and never fails, whatever other people send.
 *
 * Seeded random sequences of the events that matter are applied to the real chat store over an
 * in-memory message store: messages from this user, two peers and a stranger; into live, deleted
 * and reopened conversations and one nobody opened; with message IDs that are fresh, reused
 * within and across conversations, or equal to another message's derived ID; relay times before
 * and after a deletion; replays of earlier rows; delivered in one batch or over several polls;
 * with deletions in between. After each sequence the store is saved and restored through its own
 * persistence, and everything a user can see must be the same.
 *
 * A failure prints its seed. Replay one with `PROPERTY_SEED=<seed>`; change the number of cases
 * with `PROPERTY_CASES`.
 *
 * Plain `node` environment; see `chats.jest.test.ts`'s header for why.
 */
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  collidedMessageId,
  useChatStore,
  type Conversation,
  type RestorableState,
} from './chats'
import { useContactStore } from './contacts'
import { displayNetwork } from '../utils/constants'
import { STORE_SCHEMA_VERSION } from 'src/boot/pinia'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageWrapper } from '@frank/cashweb/types/messages'

// What the on-disk message store does, as far as this needs: rows by digest, handed back in key
// order, and a cleared row's receipt suppressed if the relay delivers it again.
const mockDisk = {
  rows: new Map<string, MessageWrapper>(),
  suppressed: new Set<string>(),
}
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (row: MessageWrapper) => {
      // As JSON, the way a row reaches the disk.
      mockDisk.rows.set(row.index, JSON.parse(JSON.stringify(row)))
    },
    deleteMessage: async (index: string) => {
      mockDisk.rows.delete(index)
    },
    suppressAndDelete: async (
      _recipient: string,
      digests: string[],
      suppressions: Array<{ payloadDigest: string }>,
    ) => {
      for (const digest of digests) mockDisk.rows.delete(digest)
      for (const entry of suppressions)
        mockDisk.suppressed.add(entry.payloadDigest)
    },
    suppressedRelayReceipts: async (
      _recipient: string,
      receipts: Array<{ payloadDigest: string }>,
    ) =>
      new Set(
        receipts
          .map(receipt => receipt.payloadDigest)
          .filter(digest => mockDisk.suppressed.has(digest)),
      ),
    quarantineRelayReceipts: async () => undefined,
    mostRecentMessageTime: async () => 0,
    relayCursor: async () => 0,
    getIterator: async function* () {
      for (const key of [...mockDisk.rows.keys()].sort())
        yield JSON.parse(JSON.stringify(mockDisk.rows.get(key)))
    },
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER_1 = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const PEER_2 = '0x3333333333333333333333333333333333333333'
const STRANGER = '0x5555555555555555555555555555555555555555'
const WITH_PEER_1 = '11111111-1111-4111-8111-111111111111'
const WITH_PEER_2 = '22222222-2222-4222-8222-222222222222'
const UNOPENED = '33333333-3333-4333-8333-333333333333'
const CONVERSATIONS = [WITH_PEER_1, WITH_PEER_2, UNOPENED]
const PEER_OF: Record<string, string> = {
  [WITH_PEER_1]: PEER_1,
  [WITH_PEER_2]: PEER_2,
  [UNOPENED]: PEER_1,
}

/** mulberry32: small, seeded, repeatable. */
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    chance: (probability: number) => next() < probability,
    int: (below: number) => Math.floor(next() * below),
    pick: <T>(values: readonly T[]): T =>
      values[Math.floor(next() * values.length)],
  }
}

type Step =
  | { kind: 'receive'; batch: ReceivedMessageWrapper[] }
  | { kind: 'delete'; conversationId: string; deletedAt: number }

function sequence(seed: number): Step[] {
  const random = generator(seed)
  const count = 4 + random.int(11)
  const digest = (n: number) => `case${seed}-message${n}`
  const sent: ReceivedMessageWrapper[] = []
  const steps: Step[] = []
  let batch: ReceivedMessageWrapper[] = []
  const flush = () => {
    if (batch.length > 0) steps.push({ kind: 'receive', batch })
    batch = []
  }
  for (let n = 0; n < count; n++) {
    if (random.chance(0.2)) {
      flush()
      steps.push({
        kind: 'delete',
        conversationId: random.pick(CONVERSATIONS),
        deletedAt: 1 + random.int(100),
      })
      continue
    }
    if (sent.length > 0 && random.chance(0.1)) {
      // The relay hands an earlier row back.
      batch.push(random.pick(sent))
    } else {
      const conversationId = random.pick(CONVERSATIONS)
      const sender = random.pick([PEER_1, PEER_2, STRANGER, ME, PEER_1])
      const outbound = sender === ME
      // Our own row names who it was sent to: usually the conversation's peer.
      const coparty = outbound
        ? random.chance(0.8)
          ? PEER_OF[conversationId]
          : PEER_2
        : sender
      const named = random.pick(['shared-1', 'shared-2'])
      const idKind = random.int(20)
      const messageId =
        idKind < 8
          ? undefined
          : idKind < 16
          ? named
          : // The ID another message of this sequence would be re-filed under.
            collidedMessageId(named, digest(random.int(count)))
      const time = 1 + random.int(100)
      const wrapper = {
        conversationId,
        outbound,
        senderAddress: sender,
        copartyAddress: coparty,
        copartyPubKey: { toBuffer: () => new Uint8Array(33) },
        index: digest(n),
        stampValue: 0,
        message: {
          conversationId,
          outbound,
          status: 'confirmed',
          senderAddress: sender,
          destinationAddress: outbound ? coparty : ME,
          items: [{ type: 'text', text: digest(n) }],
          serverTime: time,
          receivedTime: time,
          outpoints: [],
          ...(messageId === undefined ? {} : { logicalMessageId: messageId }),
        },
      } as unknown as ReceivedMessageWrapper
      sent.push(wrapper)
      batch.push(wrapper)
    }
    if (random.chance(0.5)) flush()
  }
  flush()
  return steps
}

/** Everything of the chats a user can see, plus which conversation holds each message ID. */
function visible(state: {
  conversations: Record<string, Conversation | undefined>
  logicalMessages?: Record<string, { conversationId: string } | undefined>
}) {
  return {
    conversations: Object.values(state.conversations)
      .filter((c): c is Conversation => c !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(c => ({
        id: c.id,
        peer: c.address,
        kind: c.kind,
        subject: c.name,
        deletedAt: c.deletedAt,
        clearedBefore: c.clearedBefore,
        participants: [...c.participants].sort(),
        unread: c.totalUnreadMessages,
        messages: c.messages.map(m => ({
          digest: m.payloadDigest,
          sender: m.senderAddress,
          mine: m.outbound,
          id: m.logicalMessageId,
        })),
      })),
    messageIds: Object.fromEntries(
      Object.entries(state.logicalMessages ?? {})
        .filter(([, record]) => record !== undefined)
        .map(([id, record]) => [id, record!.conversationId])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  }
}

type Persistence = {
  save: (
    storage: { put: (key: string, value: string) => Promise<void> },
    mutation: unknown,
    state: unknown,
  ) => Promise<void>
  restore: (
    storage: { get: (key: string) => Promise<string> },
    metadata: { networkName: string; version: number },
  ) => Promise<RestorableState>
}

async function openStore() {
  mockDisk.rows.clear()
  mockDisk.suppressed.clear()
  const pinia = createPinia()
  let persistence: Persistence | undefined
  pinia.use(({ store, options }) => {
    if (store.$id === 'chats')
      persistence = (options as unknown as { storage: Persistence }).storage
  })
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const chats = useChatStore()
  jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
  chats.createConversation({
    participants: [ME, PEER_1],
    address: PEER_1,
    conversationId: WITH_PEER_1,
  })
  chats.createConversation({
    participants: [ME, PEER_2],
    address: PEER_2,
    conversationId: WITH_PEER_2,
    name: 'A subject',
  })

  // Saved and restored the way the app does it.
  const saved = new Map<string, string>()
  const reload = async (state: unknown) => {
    await persistence!.save(
      { put: async (key, value) => void saved.set(key, value) },
      undefined,
      state,
    )
    return persistence!.restore(
      { get: async key => saved.get(key) ?? '{}' },
      { networkName: displayNetwork, version: STORE_SCHEMA_VERSION },
    )
  }
  return { chats, reload }
}

async function apply(
  chats: ReturnType<typeof useChatStore>,
  steps: readonly Step[],
) {
  for (const step of steps) {
    if (step.kind === 'receive') await chats.receiveMessages(step.batch, ME)
    else if (chats.conversations[step.conversationId])
      await chats.deleteConversation(step.conversationId, step.deletedAt)
  }
}

/** The session, a reload of it, and a reload of that reload all show the same. */
async function expectReloadShowsTheSession(steps: readonly Step[]) {
  const { chats, reload } = await openStore()
  await apply(chats, steps)
  const session = visible(chats.$state)
  const reloaded = await reload(chats.$state)
  expect(visible(reloaded as never)).toEqual(session)
  expect(visible((await reload(reloaded)) as never)).toEqual(session)
  return { chats, session }
}

/** The row a received message is kept as on disk. */
function row(wrapper: ReceivedMessageWrapper): MessageWrapper {
  return JSON.parse(
    JSON.stringify({
      index: wrapper.index,
      outbound: wrapper.outbound,
      senderAddress: wrapper.senderAddress,
      copartyAddress: wrapper.copartyAddress,
      message: wrapper.message,
    }),
  )
}

function message(
  index: string,
  sender: string,
  conversationId: string,
  time: number,
  messageId?: string,
): ReceivedMessageWrapper {
  const outbound = sender === ME
  const coparty = outbound ? PEER_OF[conversationId] : sender
  return {
    conversationId,
    outbound,
    senderAddress: sender,
    copartyAddress: coparty,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index,
    stampValue: 0,
    message: {
      conversationId,
      outbound,
      status: 'confirmed',
      senderAddress: sender,
      destinationAddress: outbound ? coparty : ME,
      items: [{ type: 'text', text: index }],
      serverTime: time,
      receivedTime: time,
      outpoints: [],
      ...(messageId === undefined ? {} : { logicalMessageId: messageId }),
    },
  } as unknown as ReceivedMessageWrapper
}

async function quietly(run: () => Promise<void>) {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
    /* refused rows are reported here; thousands of them are expected */
  })
  const log = jest.spyOn(console, 'log').mockImplementation(() => {
    /* the store logs every receive */
  })
  try {
    await run()
  } finally {
    warn.mockRestore()
    log.mockRestore()
  }
}

const describeSteps = (steps: readonly Step[]) =>
  steps
    .map(step =>
      step.kind === 'delete'
        ? `delete ${step.conversationId} at ${step.deletedAt}`
        : `receive ${step.batch
            .map(
              w =>
                `[${w.index} from ${w.senderAddress.slice(0, 6)}${
                  w.outbound ? ` to ${w.copartyAddress.slice(0, 6)}` : ''
                } into ${String(w.conversationId).slice(0, 4)} id ${
                  w.message.logicalMessageId ?? '-'
                } t=${w.message.serverTime}]`,
            )
            .join(' ')}`,
    )
    .join('\n')

describe('a reload shows what the session showed, whatever was received', () => {
  const only = process.env.PROPERTY_SEED
  const cases = Number(process.env.PROPERTY_CASES ?? 3000)
  const seeds = only
    ? [Number(only)]
    : Array.from({ length: cases }, (_, n) => n + 1)

  it(`holds for ${seeds.length} seeded sequences applied to the store`, async () => {
    await quietly(async () => {
      for (const seed of seeds) {
        const steps = sequence(seed)
        try {
          await expectReloadShowsTheSession(steps)
        } catch (error) {
          throw new Error(
            `seed ${seed} failed (replay with PROPERTY_SEED=${seed}):\n${describeSteps(
              steps,
            )}\n${(error as Error).message}`,
          )
        }
      }
    })
  }, 120_000)

  // Rows no receive of this version would have saved together: an older version's store, or a
  // stop between two writes. Whatever other people's rows are on disk and however they relate
  // to each other, the store loads, and what it loaded loads again. (Only loading is claimed
  // here: such a store has no session to compare with.)
  it(`loads ${seeds.length} seeded stores of arbitrary received rows, twice over`, async () => {
    await quietly(async () => {
      for (const seed of seeds) {
        const steps = sequence(seed)
        const { chats, reload } = await openStore()
        const random = generator(seed ^ 0x5bd1e995)
        for (const step of steps) {
          if (step.kind === 'delete') {
            const conversation = chats.conversations[step.conversationId]
            if (conversation) conversation.deletedAt = step.deletedAt
            continue
          }
          for (const wrapper of step.batch) {
            // Our own rows are our own outbox; only those to the conversation's peer are a
            // state other people can bring about.
            if (
              wrapper.outbound &&
              (wrapper.conversationId === UNOPENED ||
                wrapper.copartyAddress !==
                  PEER_OF[String(wrapper.conversationId)])
            )
              continue
            const kept = row(wrapper)
            // Sometimes already re-filed, under an ID something else may also hold.
            if (random.chance(0.2))
              kept.message.logicalMessageId = collidedMessageId(
                random.pick(['shared-1', 'shared-2']),
                `case${seed}-message${random.int(8)}`,
              )
            mockDisk.rows.set(kept.index, kept)
          }
        }
        try {
          const first = await reload(chats.$state)
          expect(first.conversations).toBeDefined()
          expect((await reload(first)).conversations).toBeDefined()
        } catch (error) {
          throw new Error(
            `seed ${seed} failed (replay with PROPERTY_SEED=${seed}):\n${describeSteps(
              steps,
            )}\n${(error as Error).message}`,
          )
        }
      }
    })
  }, 120_000)
})

describe('the sequences this was written for', () => {
  const CONVERSATION_D = WITH_PEER_2
  const digestOfM = 'triple-m'

  it("a peer's old message after a deletion, then two messages built to collide: nothing of it stops a reload", async () => {
    await quietly(async () => {
      const { chats, session } = await expectReloadShowsTheSession([
        { kind: 'delete', conversationId: WITH_PEER_1, deletedAt: 500 },
        {
          kind: 'receive',
          batch: [message('triple-p', PEER_1, WITH_PEER_1, 400, 'L')],
        },
        {
          kind: 'receive',
          batch: [
            message(
              'triple-r',
              STRANGER,
              UNOPENED,
              600,
              collidedMessageId('L', digestOfM),
            ),
          ],
        },
        {
          kind: 'receive',
          batch: [message(digestOfM, STRANGER, CONVERSATION_D, 700, 'L')],
        },
      ])
      // The old message did not come back, so it holds nothing; the other two are kept.
      expect([...mockDisk.rows.keys()].sort()).toEqual(['triple-m', 'triple-r'])
      expect(chats.conversations[WITH_PEER_1].deletedAt).toBe(500)
      expect(session.messageIds).toEqual({
        L: CONVERSATION_D,
        [collidedMessageId('L', digestOfM)]: UNOPENED,
      })
    })
  })

  it('the same three rows already on disk load: the last is re-filed until its ID is free', async () => {
    await quietly(async () => {
      const { chats, reload } = await openStore()
      chats.conversations[WITH_PEER_1].deletedAt = 500
      const once = collidedMessageId('L', digestOfM)
      for (const wrapper of [
        message('triple-p', PEER_1, WITH_PEER_1, 400, 'L'),
        message('triple-r', STRANGER, UNOPENED, 600, once),
        message(digestOfM, STRANGER, CONVERSATION_D, 700, 'L'),
      ])
        mockDisk.rows.set(wrapper.index, row(wrapper))
      for (let attempt = 0; attempt < 2; attempt++) {
        const reloaded = visible((await reload(chats.$state)) as never)
        expect(reloaded.messageIds).toEqual({
          L: WITH_PEER_1,
          [once]: UNOPENED,
          [collidedMessageId(once, digestOfM)]: CONVERSATION_D,
        })
        const deleted = reloaded.conversations.find(c => c.id === WITH_PEER_1)
        expect(deleted).toMatchObject({
          deletedAt: 500,
          messages: [],
          unread: 0,
        })
      }
    })
  })

  it("a peer's replayed message older than the deletion is absent in the session and after a reload, and counts nowhere", async () => {
    await quietly(async () => {
      const { session } = await expectReloadShowsTheSession([
        {
          kind: 'receive',
          batch: [message('replay-kept', PEER_1, WITH_PEER_1, 300)],
        },
        { kind: 'delete', conversationId: WITH_PEER_1, deletedAt: 500 },
        {
          kind: 'receive',
          batch: [message('replay-old', PEER_1, WITH_PEER_1, 400)],
        },
      ])
      expect(
        session.conversations.find(c => c.id === WITH_PEER_1),
      ).toMatchObject({ deletedAt: 500, messages: [], unread: 0 })
      expect(mockDisk.rows.size).toBe(0)
    })
  })

  it('a new message from the peer after the deletion reopens it, with only the new message', async () => {
    await quietly(async () => {
      const { session } = await expectReloadShowsTheSession([
        {
          kind: 'receive',
          batch: [message('reopen-old', PEER_1, WITH_PEER_1, 300)],
        },
        { kind: 'delete', conversationId: WITH_PEER_1, deletedAt: 500 },
        {
          kind: 'receive',
          batch: [
            message('reopen-stranger', STRANGER, WITH_PEER_1, 550),
            message('reopen-new', PEER_1, WITH_PEER_1, 600),
          ],
        },
      ])
      const reopened = session.conversations.find(c => c.id === WITH_PEER_1)
      expect(reopened?.deletedAt).toBeUndefined()
      expect(reopened?.messages.map(m => m.digest)).toEqual(['reopen-new'])
      expect(reopened?.participants).not.toContain(STRANGER)
    })
  })
})

describe('a note to self that carries only records', () => {
  it('is in no conversation in the session or after a reload, beside messages that are', async () => {
    await quietly(async () => {
      const records = (index: string, sender: string, type: string) => {
        const wrapper = message(index, sender, WITH_PEER_1, 350)
        return {
          ...wrapper,
          conversationId: undefined,
          outbound: false,
          copartyAddress: sender,
          message: {
            ...wrapper.message,
            conversationId: undefined,
            outbound: false,
            destinationAddress: ME,
            items: [{ type, swapId: index }],
          },
        } as unknown as ReceivedMessageWrapper
      }
      const { chats, session } = await expectReloadShowsTheSession([
        {
          kind: 'receive',
          batch: [
            message('before', PEER_1, WITH_PEER_1, 300),
            // Our own swap note, a peer's row built to look like one, and a wallet record
            // that should never have arrived: none of them is a message.
            records('own-swap-note', ME, 'swap-record'),
            records('peer-swap-note', PEER_1, 'swap-record'),
            records('wallet-record', ME, 'wallet-sync'),
            message('after', PEER_1, WITH_PEER_1, 400),
          ],
        },
        // The relay hands the note back on a later poll.
        {
          kind: 'receive',
          batch: [records('own-swap-note', ME, 'swap-record')],
        },
      ])
      expect(
        session.conversations.flatMap(c => c.messages.map(m => m.digest)),
      ).toEqual(['before', 'after'])
      expect([...mockDisk.rows.keys()].sort()).toEqual(['after', 'before'])
      expect(Object.keys(chats.messages).sort()).toEqual(['after', 'before'])
    })
  })
})

describe('a conversation the saved metadata does not know', () => {
  it("is rebuilt as ours with the peer we wrote to, though a stranger's row in it is older", async () => {
    await quietly(async () => {
      const { chats, reload } = await openStore()
      const FRESH = '44444444-4444-4444-8444-444444444444'
      PEER_OF[FRESH] = PEER_1
      // Saved rows of a conversation whose metadata was not yet written when the app stopped.
      for (const wrapper of [
        message('lost-stranger', STRANGER, FRESH, 10),
        message('lost-mine', ME, FRESH, 20),
      ])
        mockDisk.rows.set(wrapper.index, row(wrapper))
      const reloaded = visible((await reload(chats.$state)) as never)
      expect(reloaded.conversations.find(c => c.id === FRESH)).toMatchObject({
        peer: PEER_1,
        messages: [
          { digest: 'lost-stranger', sender: STRANGER, mine: false },
          { digest: 'lost-mine', sender: ME, mine: true },
        ],
      })
    })
  })
})

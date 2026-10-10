import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata, Entry } = __pb_registry_metadata_pb

import { BotLoopGuard, parseAddressList } from './bot-loop-guard'

const A = `0x${'aa'.repeat(20)}`
const B = `0x${'bb'.repeat(20)}`
const HUMAN = `0x${'cc'.repeat(20)}`
const MARKED = `0x${'dd'.repeat(20)}`

function profilePayload(kinds: Array<[string, string]>) {
  const metadata = new AddressMetadata()
  metadata.setEntriesList(
    kinds.map(([kind, body]) => {
      const entry = new Entry()
      entry.setKind(kind)
      entry.setBody(new TextEncoder().encode(body))
      return entry
    }),
  )
  const signed = new SignedPayload()
  signed.setPayload(metadata.serializeBinary())
  return signed
}

function guardFor(
  self: string,
  overrides: Partial<ConstructorParameters<typeof BotLoopGuard>[0]> = {},
) {
  return new BotLoopGuard({
    selfAddress: self,
    relayBaseUrl: 'http://relay.test',
    lookupIsBot: async () => false,
    ...overrides,
  })
}

describe('BotLoopGuard.peerBlockReason', () => {
  it('blocks itself, denylisted addresses (case-insensitively) and marked bots', async () => {
    const guard = guardFor(A, {
      denylist: [B.toUpperCase().replace('0X', '0x')],
      lookupIsBot: async address => address === MARKED,
    })
    expect(
      await guard.peerBlockReason(A.toUpperCase().replace('0X', '0x')),
    ).toBe('self')
    expect(await guard.peerBlockReason(B)).toBe('denylisted')
    expect(await guard.peerBlockReason(MARKED)).toBe('bot-profile')
    expect(await guard.peerBlockReason(HUMAN)).toBeUndefined()
  })

  it.each(['Error', 'object'])(
    'fails closed with only a safe diagnostic when lookup rejects with an %s',
    async rejectionKind => {
      const peer = `0x${'711abcde'.repeat(5)}`
      const secret = 'LOOKUP_BODY_PROMPT_REASONING_KEY_TOKEN_SENTINEL_711'
      const rejection =
        rejectionKind === 'Error'
          ? new Error(secret)
          : { message: secret, response: { body: secret } }
      const lookup = jest
        .fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValue(false)
      const guard = guardFor(A, { lookupIsBot: lookup })
      const output = (
        [
          'log',
          'info',
          'warn',
          'error',
          'debug',
          'trace',
          'dir',
          'dirxml',
          'table',
          'assert',
          'count',
          'countReset',
          'group',
          'groupCollapsed',
          'groupEnd',
          'time',
          'timeLog',
          'timeEnd',
          'clear',
        ] as const
      ).map(method =>
        jest.spyOn(console, method).mockImplementation(() => undefined),
      )
      try {
        expect(await guard.peerBlockReason(peer)).toBe('lookup-failed')
        expect(lookup).toHaveBeenCalledWith(peer)
        const calls = output.flatMap(spy => spy.mock.calls)
        expect(JSON.stringify(calls)).not.toContain(peer)
        expect(JSON.stringify(calls)).not.toContain(secret)
        expect(calls).toEqual([
          ['[loop-guard] profile lookup failed -- treating as automated'],
        ])
        expect(console.warn).toHaveBeenCalledTimes(1)
        // A failed lookup is not cached; the next message can recover normally.
        expect(await guard.peerBlockReason(peer)).toBeUndefined()
        expect(lookup).toHaveBeenCalledTimes(2)
      } finally {
        output.forEach(spy => spy.mockRestore())
      }
    },
  )

  it('caches the lookup for a while, then re-checks', async () => {
    let now = 1_000
    const lookup = jest.fn(async () => false)
    const guard = guardFor(A, { lookupIsBot: lookup, now: () => now })
    await guard.peerBlockReason(HUMAN)
    await guard.peerBlockReason(HUMAN)
    expect(lookup).toHaveBeenCalledTimes(1)
    now += 6 * 60 * 1000
    await guard.peerBlockReason(HUMAN)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})

describe('BotLoopGuard.profileBlockReason (greeter)', () => {
  it('skips profiles carrying the bot marker and self/denylist, greets others', () => {
    const guard = guardFor(A, { denylist: [B] })
    expect(
      guard.profileBlockReason(HUMAN, profilePayload([['bot', '1']])),
    ).toBe('bot-profile')
    expect(guard.profileBlockReason(A, profilePayload([]))).toBe('self')
    expect(guard.profileBlockReason(B, profilePayload([]))).toBe('denylisted')
    expect(
      guard.profileBlockReason(
        HUMAN,
        profilePayload([['display_name', 'Alice']]),
      ),
    ).toBeUndefined()
    // A marker with any other body (or a differently-named kind) is not a bot declaration.
    expect(
      guard.profileBlockReason(HUMAN, profilePayload([['bot', '0']])),
    ).toBeUndefined()
  })
})

describe('BotLoopGuard.reserveReply', () => {
  it('allows exactly maxRepliesPerPeer per window, per peer, then recovers', () => {
    let now = 0
    const guard = guardFor(A, {
      maxRepliesPerPeer: 3,
      windowMs: 1000,
      now: () => now,
    })
    expect([1, 2, 3, 4].map(() => guard.reserveReply(HUMAN))).toEqual([
      true,
      true,
      true,
      false,
    ])
    // Another peer has its own budget.
    expect(guard.reserveReply(B)).toBe(true)
    // Rejected attempts do not extend the block.
    now = 1001
    expect(guard.reserveReply(HUMAN)).toBe(true)
  })

  it('a budget of 0 never replies', () => {
    expect(guardFor(A, { maxRepliesPerPeer: 0 }).reserveReply(HUMAN)).toBe(
      false,
    )
  })
})

/**
 * #311 regression: two auto-replying bots that greet each other. Each stub bot does what the
 * vendor/raffle/Qwen loops do on an inbound message -- ask the guard about the sender, reserve a
 * reply, then send one. The queue is the relay; the send cap only exists so a regression fails an
 * assertion instead of hanging the suite.
 */
describe('two bots exchanging a greeting', () => {
  async function exchange(guards: Record<string, BotLoopGuard>) {
    const CAP = 10_000
    const queue: Array<{ from: string; to: string }> = [{ from: A, to: B }]
    let sent = 1
    while (queue.length > 0 && sent < CAP) {
      const { from, to } = queue.shift() as { from: string; to: string }
      const guard = guards[to]
      if (await guard.peerBlockReason(from)) continue
      if (!guard.reserveReply(from)) continue
      queue.push({ from: to, to: from })
      sent++
    }
    return sent
  }

  it('produces no replies when the bots are marked as bots', async () => {
    const marked = async () => true
    const sent = await exchange({
      [A]: guardFor(A, { lookupIsBot: marked }),
      [B]: guardFor(B, { lookupIsBot: marked }),
    })
    expect(sent).toBe(1) // the greeting only
  })

  it('produces no replies when the operator denylists the peer', async () => {
    const sent = await exchange({
      [A]: guardFor(A, { denylist: [B] }),
      [B]: guardFor(B, { denylist: [A] }),
    })
    expect(sent).toBe(1)
  })

  it('is still bounded by the per-peer budget when neither bot is marked', async () => {
    const sent = await exchange({
      [A]: guardFor(A, { maxRepliesPerPeer: 4 }),
      [B]: guardFor(B, { maxRepliesPerPeer: 4 }),
    })
    // greeting + at most 4 replies from each side.
    expect(sent).toBeLessThanOrEqual(1 + 4 + 4)
    expect(sent).toBeGreaterThan(1) // the budget, not the marker, is what stopped it
  })
})

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  createSyncSender,
  generateSyncPin,
  normalizeSyncPin,
  receiveSyncBundle,
  syncSenderConfirm,
  syncSenderHello,
  SYNC_PAIRING_MAX_FAILURES,
  SYNC_PAIRING_TTL_MS,
  type SyncPairingSend,
  type SyncSenderState,
} from './sync-pairing'

const SHARES = ['ms12frankshareone', 'ms12franksharetwo']
const bundle = () => ({ displayName: 'Ann', backupShares: [...SHARES] })

/**
 * Wires a receiver to a sender state held here, recording every message on the
 * channel so a test can check what an observer of it would see.
 */
function channel(
  sender: SyncSenderState | null,
  tamper?: (type: string, msg: any) => any,
) {
  const wire: unknown[] = []
  const outcomes: string[] = []
  let state = sender
  const send: SyncPairingSend = async (type, payload) => {
    const request = tamper ? tamper(`${type}:request`, payload) : payload
    wire.push({ type, request })
    let reply: any = { ok: false, reason: 'no-sender' }
    if (state && type === 'pair-hello') {
      const next = syncSenderHello(state)
      state = next.state
      reply = next.reply
    } else if (state) {
      const next = syncSenderConfirm(state, request)
      state = next.state
      outcomes.push(next.outcome)
      reply = next.reply
    }
    reply = tamper ? tamper(`${type}:reply`, reply) : reply
    wire.push({ type, reply })
    return reply
  }
  return { send, wire, outcomes, state: () => state }
}

describe('sync PIN pairing (CPace + XChaCha20-Poly1305)', () => {
  it('makes uniform 6-digit PINs and accepts only 6 digits', () => {
    for (let i = 0; i < 50; i++) expect(generateSyncPin()).toMatch(/^\d{6}$/)
    const spy = jest
      .spyOn(globalThis.crypto, 'getRandomValues')
      // 4294000000 is above the largest multiple of 10^6 below 2^32: rejected.
      .mockImplementationOnce(<T extends ArrayBufferView | null>(a: T) => {
        ;(a as unknown as Uint32Array)[0] = 4_294_000_000
        return a
      })
      .mockImplementationOnce(<T extends ArrayBufferView | null>(a: T) => {
        ;(a as unknown as Uint32Array)[0] = 1_000_042
        return a
      })
    try {
      expect(generateSyncPin()).toBe('000042')
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
    expect(normalizeSyncPin(' 123 456 ')).toBe('123456')
    expect(normalizeSyncPin('12345')).toBeNull()
    expect(normalizeSyncPin('12345a')).toBeNull()
  })

  it('delivers the bundle when both sides use the same PIN, then ends the session', async () => {
    const sender = createSyncSender(bundle())
    const ch = channel(sender)
    const result = await receiveSyncBundle(sender.pin, ch.send)
    expect(result).toEqual({ ok: true, bundle: bundle() })
    expect(ch.outcomes).toEqual(['sent'])
    expect(ch.state()).toBeNull()
    // An observer of the channel sees neither the shares nor the PIN.
    const seen = JSON.stringify(ch.wire)
    expect(seen).not.toContain(SHARES[0])
    expect(seen).not.toContain(sender.pin)
  })

  it('sends no ciphertext for a wrong PIN, and replaces the PIN', async () => {
    const sender = createSyncSender(bundle())
    const wrong = sender.pin === '000000' ? '000001' : '000000'
    const ch = channel(sender)
    const result = await receiveSyncBundle(wrong, ch.send)
    expect(result).toEqual({ ok: false, reason: 'pin-mismatch' })
    expect(ch.outcomes).toEqual(['new-pin'])
    const confirmReply = ch.wire.at(-1) as { reply: Record<string, unknown> }
    expect(confirmReply.reply).toEqual({ ok: false, reason: 'pin-mismatch' })
    expect(JSON.stringify(ch.wire)).not.toContain('ciphertext')
    // The sender shows a new PIN, and that one works.
    const next = ch.state()!
    expect(next.pin).toMatch(/^\d{6}$/)
    expect(next.failures).toBe(1)
    expect(await receiveSyncBundle(next.pin, ch.send)).toEqual({
      ok: true,
      bundle: bundle(),
    })
  })

  it(`ends the session after ${SYNC_PAIRING_MAX_FAILURES} wrong PINs`, async () => {
    const ch = channel(createSyncSender(bundle()))
    for (let i = 0; i < SYNC_PAIRING_MAX_FAILURES; i++) {
      const pin = ch.state()!.pin === '999999' ? '999998' : '999999'
      await receiveSyncBundle(pin, ch.send)
    }
    expect(ch.outcomes).toEqual(['new-pin', 'new-pin', 'ended'])
    expect(ch.state()).toBeNull()
    expect(await receiveSyncBundle('123456', ch.send)).toEqual({
      ok: false,
      reason: 'no-sender',
    })
  })

  it('refuses an expired session', async () => {
    const sender = createSyncSender(
      bundle(),
      Date.now() - SYNC_PAIRING_TTL_MS - 1,
    )
    const ch = channel(sender)
    expect(await receiveSyncBundle(sender.pin, ch.send)).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(JSON.stringify(ch.wire)).not.toContain('ciphertext')
  })

  it('fails when the transcript is tampered with', async () => {
    const flip = (hex: string) => {
      const bytes = hexToBytes(hex)
      bytes[0] ^= 1
      return bytesToHex(bytes)
    }
    const cases: Array<[string, (msg: any) => any]> = [
      // A different sid on the confirm does not belong to this exchange.
      ['pair-confirm:request', m => ({ ...m, sid: flip(m.sid) })],
      ['pair-confirm:request', m => ({ ...m, Tb: flip(m.Tb) })],
      ['pair-confirm:request', m => ({ ...m, Yb: flip(m.Yb) })],
      ['pair-hello:reply', m => ({ ...m, Ya: flip(m.Ya) })],
      ['pair-confirm:reply', m => ({ ...m, Ta: flip(m.Ta) })],
      ['pair-confirm:reply', m => ({ ...m, ciphertext: flip(m.ciphertext) })],
    ]
    for (const [where, change] of cases) {
      const sender = createSyncSender(bundle())
      const ch = channel(sender, (at, msg) =>
        at === where && msg?.ok !== false ? change(msg) : msg,
      )
      const result = await receiveSyncBundle(sender.pin, ch.send)
      expect(result.ok).toBe(false)
    }
  })

  it('gives each attempt a fresh session id and key share', () => {
    const sender = createSyncSender(bundle())
    const a = syncSenderHello(sender).reply
    const b = syncSenderHello(sender).reply
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.sid).not.toBe(b.sid)
      expect(a.Ya).not.toBe(b.Ya)
    }
  })

  describe('attack probes (crypto review)', () => {
    const T0 = '00'.repeat(64)
    const hello = (state: SyncSenderState) => {
      const next = syncSenderHello(state)
      if (!next.reply.ok || !next.state) throw new Error('hello failed')
      return { state: next.state, sid: next.reply.sid, Ya: next.reply.Ya }
    }

    it('a stale or swapped sid is not a guess and leaves the PIN unchanged', () => {
      const h = hello(createSyncSender(bundle()))
      for (const req of [
        { sid: '11'.repeat(16), Yb: h.Ya, Tb: T0 },
        { Yb: h.Ya, Tb: T0 },
      ]) {
        const next = syncSenderConfirm(h.state, req)
        expect(next.outcome).toBe('stale')
        expect(next.reply).toEqual({ ok: false, reason: 'stale' })
        expect(next.state).toBe(h.state)
        expect(next.state?.pin).toBe(h.state.pin)
        expect(next.state?.failures).toBe(0)
      }
    })

    it('the identity point as Yb counts as a wrong PIN', () => {
      const h = hello(createSyncSender(bundle()))
      const next = syncSenderConfirm(h.state, {
        sid: h.sid,
        Yb: '00'.repeat(32),
        Tb: T0,
      })
      expect(next.outcome).toBe('new-pin')
      expect(next.reply).toEqual({ ok: false, reason: 'pin-mismatch' })
      expect(next.state?.failures).toBe(1)
      expect(next.state?.attempt).toBeNull()
    })

    it('Ya reflected back as Yb counts as a wrong PIN', () => {
      const h = hello(createSyncSender(bundle()))
      const next = syncSenderConfirm(h.state, { sid: h.sid, Yb: h.Ya, Tb: T0 })
      expect(next.outcome).toBe('new-pin')
      expect(next.reply.ok).toBe(false)
    })

    it('a valid (Yb, Tb) for attempt N does not open attempt N+1', async () => {
      let state = createSyncSender(bundle())
      // An honest receiver with the right PIN; its confirm is captured, not delivered.
      let captured: any
      await receiveSyncBundle(state.pin, async (type, payload) => {
        if (type === 'pair-hello') {
          const n = syncSenderHello(state)
          state = n.state!
          return n.reply
        }
        captured = payload
        return { ok: false, reason: 'failed' }
      })
      const next = hello(state)
      const replayed = syncSenderConfirm(next.state, {
        ...captured,
        sid: next.sid,
      })
      expect(replayed.reply).toEqual({ ok: false, reason: 'pin-mismatch' })
      expect(JSON.stringify(replayed.reply)).not.toContain('ciphertext')
      // Under its own, superseded sid it is merely stale.
      expect(syncSenderConfirm(next.state, captured).outcome).toBe('stale')
    })
  })
})

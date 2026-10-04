import { randomBytes as nodeRandomBytes } from 'crypto'

import {
  BASE_OT_COUNT,
  baseOtContext,
  receiverChoose,
  receiverRespond,
  receiverSeeds,
  receiverVerify,
  requireSenderKey,
  senderKey,
  senderOpen,
  senderPads,
  senderSeeds,
} from './base-ot.js'
import { bit, equalBytes } from './bytes.js'
import { CURVE_ORDER } from './group.js'
import {
  extendReceiver,
  extendSender,
  extensionNonce,
  padPrefix,
  receiverPads,
  senderPadPairs,
  VOLE_OT_COUNT,
} from './ot-extension.js'
import { failureCode } from './result.js'
import {
  extensionDigest,
  VOLE_COLUMNS,
  voleContext,
  voleReceive,
  voleSend,
} from './vole.js'

const rng = (length: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(length))
const alice = Uint8Array.of(1)
const bob = Uint8Array.of(2)

function code(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return failureCode(error)
  }
}

function flipped(bytes: Uint8Array, index: number, mask = 1): Uint8Array {
  const out = bytes.slice()
  out[index] = (out[index] ?? 0) ^ mask
  return out
}

/** A complete honest base-OT instance: sender alice, receiver bob. */
function baseOt() {
  const binding = rng(32)
  const context = baseOtContext(binding, alice, bob)
  const key = senderKey(rng, binding, alice)
  const B = requireSenderKey(binding, alice, key.message)
  const chosen = receiverChoose(rng, context, B)
  const pads = senderPads(context, key.secret, B, chosen.message)
  const responses = receiverRespond(
    context,
    chosen.choices,
    chosen.pads,
    pads.message,
  )
  const openings = senderOpen(context, pads.pads0, pads.pads1, responses)
  receiverVerify(context, chosen.choices, chosen.pads, pads.message, openings)
  return {
    binding,
    context,
    key,
    B,
    chosen,
    pads,
    responses,
    openings,
    pairs: senderSeeds(context, pads.pads0, pads.pads1),
    seeds: receiverSeeds(context, chosen.pads),
  }
}

describe('base OT (VSOT)', () => {
  const run = baseOt()

  it('gives the receiver exactly the chosen seed of every pair', () => {
    for (let j = 0; j < BASE_OT_COUNT; j += 1) {
      const choice = bit(run.chosen.choices, j)
      const mine = run.seeds.subarray(j * 32, (j + 1) * 32)
      const chosen = run.pairs.subarray(
        (2 * j + choice) * 32,
        (2 * j + choice + 1) * 32,
      )
      const other = run.pairs.subarray(
        (2 * j + 1 - choice) * 32,
        (2 * j + 2 - choice) * 32,
      )
      expect(equalBytes(mine, chosen)).toBe(true)
      expect(equalBytes(mine, other)).toBe(false)
    }
  })

  it('rejects a sender key without a valid proof of knowledge', () => {
    expect(
      code(() =>
        requireSenderKey(
          run.binding,
          alice,
          flipped(run.key.message, run.key.message.length - 1),
        ),
      ),
    ).toBe('invalid-proof')
    // A proof made for another identity or binding is not accepted.
    expect(
      code(() => requireSenderKey(run.binding, bob, run.key.message)),
    ).toBe('invalid-proof')
    expect(code(() => requireSenderKey(rng(32), alice, run.key.message))).toBe(
      'invalid-proof',
    )
  })

  it('rejects an encoded choice equal to the sender key or off the curve', () => {
    const equal = run.chosen.message.slice()
    equal.set(run.B, 33 * 5)
    expect(
      code(() => senderPads(run.context, run.key.secret, run.B, equal)),
    ).toBe('invalid-point')
    const off = run.chosen.message.slice()
    off[0] = 0x05
    expect(
      code(() => senderPads(run.context, run.key.secret, run.B, off)),
    ).toBe('invalid-point')
  })

  it('detects a receiver that does not know its pad', () => {
    expect(
      code(() =>
        senderOpen(
          run.context,
          run.pads.pads0,
          run.pads.pads1,
          flipped(run.responses, 32 * 77),
        ),
      ),
    ).toBe('base-ot-check-failed')
  })

  it('detects a sender that tests a guess of a choice bit', () => {
    // A sender that alters challenge j learns from the response whether
    // choice j is 0. The receiver catches it when it checks the opening
    // against the challenge it was sent.
    expect(
      code(() =>
        receiverVerify(
          run.context,
          run.chosen.choices,
          run.chosen.pads,
          flipped(run.pads.message, 32 * 3, 0x80),
          run.openings,
        ),
      ),
    ).toBe('base-ot-check-failed')
    // A wrong opening of the chosen pad is caught as well.
    const j = 9
    expect(
      code(() =>
        receiverVerify(
          run.context,
          run.chosen.choices,
          run.chosen.pads,
          run.pads.message,
          flipped(run.openings, (2 * j + bit(run.chosen.choices, j)) * 32),
        ),
      ),
    ).toBe('base-ot-check-failed')
  })
})

describe('OT extension and multiplication', () => {
  const base = baseOt()
  const binding = rng(32)
  // alice was the base-OT sender, so alice is the extension receiver.
  const nonce = extensionNonce(binding, alice, bob)
  const prefix = padPrefix(binding, alice, bob)
  const receiver = extendReceiver(base.pairs, nonce)
  const rows = extendSender(
    base.chosen.choices,
    base.seeds,
    nonce,
    receiver.message,
  )
  const pairs = senderPadPairs(prefix, rows, base.chosen.choices, VOLE_COLUMNS)
  const pads = receiverPads(prefix, receiver.rows, VOLE_COLUMNS)
  const context = voleContext(binding, alice, bob)
  const extension = extensionDigest(receiver.message)

  it('gives the receiver the pad of its choice bit for every OT', () => {
    let ones = 0
    const width = 32 * VOLE_COLUMNS
    for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
      const choice = bit(receiver.choices, j)
      ones += choice
      const mine = pads.subarray(j * width, (j + 1) * width)
      const chosen = (choice === 1 ? pairs.one : pairs.zero).subarray(
        j * width,
        (j + 1) * width,
      )
      const other = (choice === 1 ? pairs.zero : pairs.one).subarray(
        j * width,
        (j + 1) * width,
      )
      expect(equalBytes(mine, chosen)).toBe(true)
      expect(equalBytes(mine, other)).toBe(false)
    }
    expect(ones).toBeGreaterThan(250)
    expect(ones).toBeLessThan(450)
  })

  it('is deterministic in the nonce and different under another nonce', () => {
    expect(
      equalBytes(extendReceiver(base.pairs, nonce).message, receiver.message),
    ).toBe(true)
    const other = extendReceiver(
      base.pairs,
      extensionNonce(rng(32), alice, bob),
    )
    expect(equalBytes(other.message, receiver.message)).toBe(false)
    expect(equalBytes(other.choices, receiver.choices)).toBe(false)
  })

  it('rejects any altered byte of the extension message', () => {
    const length = receiver.message.length
    for (const index of [0, 5000, length - 40, length - 1]) {
      expect(
        code(() =>
          extendSender(
            base.chosen.choices,
            base.seeds,
            nonce,
            flipped(receiver.message, index),
          ),
        ),
      ).toBe('ot-extension-check-failed')
    }
  })

  it('multiplies: t + r = alpha * beta', () => {
    const sent = voleSend(rng, context, extension, pairs.zero, pairs.one)
    const received = voleReceive(
      context,
      extension,
      receiver.choices,
      pads,
      sent.message,
    )
    for (let c = 0; c < 2; c += 1) {
      const left =
        ((sent.shares[c] ?? 0n) + (received.shares[c] ?? 0n)) % CURVE_ORDER
      const right = ((sent.alpha[c] ?? 0n) * received.beta) % CURVE_ORDER
      expect(left).toBe(right)
    }
    expect(received.beta).not.toBe(0n)
  })

  it('rejects an altered multiplication message, context or OT transcript', () => {
    const sent = voleSend(rng, context, extension, pairs.zero, pairs.one)
    const length = sent.message.length
    for (const index of [31, 32 * 100 + 31, length - 40, length - 1]) {
      expect(
        code(() =>
          voleReceive(
            context,
            extension,
            receiver.choices,
            pads,
            flipped(sent.message, index),
          ),
        ),
      ).toBe('multiplication-check-failed')
    }
    expect(
      code(() =>
        voleReceive(
          voleContext(rng(32), alice, bob),
          extension,
          receiver.choices,
          pads,
          sent.message,
        ),
      ),
    ).toBe('multiplication-check-failed')
    expect(
      code(() =>
        voleReceive(context, rng(32), receiver.choices, pads, sent.message),
      ),
    ).toBe('multiplication-check-failed')
  })
})

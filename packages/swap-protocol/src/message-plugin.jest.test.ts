import * as negotiation from './negotiation'
import { readFileSync } from 'fs'
import { standaloneItemBudget } from '@frank/codec'
import { MonadIdentity } from '../../wallet/evm-identity'
import { encodeSignedSwapEvent, type SwapResult } from './index'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
} from './negotiation'
import { createNegotiationMessagePlugin } from './message-plugin'

function must<T>(v: SwapResult<T>): T {
  if (!v.ok) throw new Error(v.error.code)
  return v.value
}
const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const context = {
  swapId: new Uint8Array(32).fill(1),
  conversationId: new Uint8Array(16).fill(2),
  parties: [a.compressedPubKey, b.compressedPubKey] as const,
  policy: TESTNET_NEGOTIATION_POLICY,
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
let events: Uint8Array[]
beforeAll(async () => {
  const offer = must(
    await buildNegotiationOffer(
      context,
      { xecPrincipal: 12345n, evmPrincipal: 10n ** 18n, expiry: 2000000000n },
      async d => a.signHash(Buffer.from(d)),
    ),
  )
  const encoded = must(encodeSignedSwapEvent(offer))
  events = [encoded]
  for (const kind of ['accept', 'reject'] as const)
    events.push(
      must(
        encodeSignedSwapEvent(
          must(
            await buildNegotiationResponse(context, encoded, kind, async d =>
              b.signHash(Buffer.from(d)),
            ),
          ),
        ),
      ),
    )
})
it('preserves all signed bytes through frozen projections, restored JSON, encode and inert previews', () => {
  const p = createNegotiationMessagePlugin(TESTNET_NEGOTIATION_POLICY)
  const decode = jest.spyOn(negotiation, 'decodeNegotiationEventSchema')
  events.forEach((encoded, index) => {
    decode.mockClear()
    const value = p.decode(encoded, { budget: standaloneItemBudget() })
    expect(Object.isFrozen(value)).toBe(true)
    expect(p.read(value)).toBe(value)
    expect(() => Object.assign(value, { eventHex: '00' })).toThrow()
    expect(decode).toHaveBeenCalledTimes(1)
    const restored = p.read(JSON.parse(JSON.stringify(value)))
    expect(decode).toHaveBeenCalledTimes(2)
    expect(restored).not.toBe(value)
    expect(p.encode(restored)).toEqual(encoded)
    expect(p.previewText(restored)).toBe(
      ['Swap offer', 'Swap acceptance message', 'Swap rejection message'][
        index
      ],
    )
    expect(Object.keys(restored)).toEqual(['eventHex'])
  })
  decode.mockRestore()
  expect(Object.keys(p).sort()).toEqual([
    'decode',
    'encode',
    'itemType',
    'previewText',
    'read',
  ])
})
it('fully revalidates arbitrary/restored projections and rejects mutations, noncanonical hex and extra fields', () => {
  const p = createNegotiationMessagePlugin(TESTNET_NEGOTIATION_POLICY)
  const valid = { eventHex: hex(events[0]) }
  for (const raw of [
    null,
    [],
    {},
    { ...valid, extra: 0 },
    { eventHex: valid.eventHex.toUpperCase() },
    { eventHex: '0' },
    { eventHex: '00'.repeat(1025) },
    { eventHex: '00' },
    {
      get eventHex() {
        throw Error('getter')
      },
    },
  ])
    expect(() => p.read(raw)).toThrow()
  const restored = JSON.parse(JSON.stringify(p.read(valid)))
  restored.eventHex = '00'
  expect(() => p.read(restored)).toThrow()
  const invalid = new Uint8Array(events[0])
  invalid[invalid.length - 1] ^= 1
  expect(() => p.read({ eventHex: hex(invalid) })).toThrow()
  expect(() => p.decode(invalid, { budget: standaloneItemBudget() })).toThrow()
})
it('charges each received event to the supplied budget even for repeated cached-equivalent bytes', () => {
  const p = createNegotiationMessagePlugin(TESTNET_NEGOTIATION_POLICY)
  const budget = standaloneItemBudget()
  const spy = jest.spyOn(budget, 'decodeCbor')
  const first = p.decode(events[0], { budget })
  const count = spy.mock.calls.length
  expect(count).toBe(1)
  p.read(first)
  p.encode(first)
  p.previewText(first)
  expect(spy).toHaveBeenCalledTimes(count)
  p.decode(events[0], { budget })
  expect(spy).toHaveBeenCalledTimes(count * 2)
  const restored = JSON.parse(JSON.stringify(first))
  // A new object cannot claim the prior validation, even with matching eventHex.
  const changed = { ...restored, eventHex: '00' }
  expect(() => p.read(changed)).toThrow()
  const failBudget = {
    ...budget,
    decodeCbor: () => {
      throw new Error('enclosing exhausted')
    },
  }
  expect(() => p.decode(events[0], { budget: failBudget })).toThrow()
})
it('keeps the feature entry independent of custody, wallet, UI and framework', () => {
  const source = readFileSync(__dirname + '/message-plugin.ts', 'utf8')
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1])
  expect(imports.sort()).toEqual(['./negotiation', '@frank/codec'])
})

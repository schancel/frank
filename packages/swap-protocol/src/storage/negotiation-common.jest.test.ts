import { bind, negotiationStorageLimits } from './negotiation-common'
import { a, b, binding } from './storage-cases.testutil'
it('requires bounded scalar UTF8 host/account strings and an actual compressed secp256k1 key', () => {
  for (const hostDiscriminator of [
    '',
    'a'.repeat(129),
    'é'.repeat(65),
    '\ud800',
  ])
    expect(() => bind({ ...binding, hostDiscriminator })).toThrow()
  for (const accountIncarnation of [
    '',
    'a'.repeat(257),
    'é'.repeat(129),
    '\udfff',
  ])
    expect(() => bind({ ...binding, accountIncarnation })).toThrow()
  for (const localPublicKey of [
    new Uint8Array(32),
    new Uint8Array(33).fill(0xff),
  ])
    expect(() => bind({ ...binding, localPublicKey })).toThrow()
  expect(
    bind({
      ...binding,
      hostDiscriminator: 'é'.repeat(64),
      accountIncarnation: 'é'.repeat(128),
    }).namespace,
  ).toMatch(/^frank-swap-negotiation-v1-[0-9a-f]{64}$/)
  expect(negotiationStorageLimits).toEqual({ rows: 128, rawBytes: 8388608 })
})
it('length-frames account/host/key affinity and persists a complete normalized binding snapshot', () => {
  const key = Buffer.from(a),
    first = bind({
      ...binding,
      hostDiscriminator: 'ab',
      accountIncarnation: 'c',
      localPublicKey: key,
    })
  key.set(b)
  expect(JSON.parse(first.metadata)).toEqual({
    version: 1,
    hostDiscriminator: 'ab',
    accountIncarnation: 'c',
    localPublicKey: Buffer.from(a).toString('hex'),
  })
  expect(first.namespace).not.toBe(
    bind({ ...binding, hostDiscriminator: 'a', accountIncarnation: 'bc' })
      .namespace,
  )
  expect(first.namespace).not.toBe(
    bind({
      ...binding,
      hostDiscriminator: 'ab',
      accountIncarnation: 'c',
      localPublicKey: b,
    }).namespace,
  )
  expect(Object.isFrozen(first)).toBe(true)
})

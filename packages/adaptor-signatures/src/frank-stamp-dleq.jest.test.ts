import {
  createFrankStampProof,
  frankStampDeterministicNonce,
  verifyFrankStampProof,
} from './frank-stamp-dleq'

const hex = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'hex'))
const hexOf = (value: Uint8Array): string => Buffer.from(value).toString('hex')

const stampKey = hex(
  '03f7fc9b839b4c4c8ff821777ecc410b461d6ca6b36e931ddbfadda8b37a55ae33',
)
const ephemeralSecret = hex(
  'dc99a5298a2008c5d8980f5f2524335a6810606642ad01c8653b053663a86d85',
)
const expectedEphemeral =
  '022f88fd8059bf1bfda332a2ff01f4667efdc1d8526562ecbd6bcac57ace81b6c3'
const expectedShared =
  '02d066aa56e65e5cba4051500237a51ae9fd16c2c3476904d47d667f9fe1fca3e9'
const expectedNonce =
  '488a39bee567858c457d6b53bcd01e5cc30cd0ff115fac29dae896d93ef9c9ef'
const expectedProof =
  'bf8f2ddfeb72fb808d95507bf325ca2e09ea762fd874aef4422a74b7b82e327d' +
  'a6708a4fa9553e426718e3cf8ed714d75546b0458f8a4ef1820c30dce4b0163a'

it('matches the Frank-CBOR T3c worked vector', () => {
  const ephemeralPoint = hex(expectedEphemeral)
  const sharedPoint = hex(expectedShared)
  const proofNonce = frankStampDeterministicNonce({
    network: 'monad',
    ephemeralSecret,
    stampKey,
    ephemeralPoint,
    sharedPoint,
  })
  expect(hexOf(proofNonce)).toBe(expectedNonce)
  const material = createFrankStampProof({
    network: 'monad',
    stampKey,
    ephemeralSecret,
    proofNonce,
  })
  expect(hexOf(material.ephemeralPoint)).toBe(expectedEphemeral)
  expect(hexOf(material.sharedPoint)).toBe(expectedShared)
  expect(hexOf(material.proof)).toBe(expectedProof)
  expect(
    verifyFrankStampProof({ network: 'monad', stampKey, ...material }),
  ).toBe(true)
  expect(
    verifyFrankStampProof({ network: 'other', stampKey, ...material }),
  ).toBe(false)
})

it('rejects an overlong network before entering the proof nonce loop', () => {
  expect(() =>
    createFrankStampProof({
      network: 'x'.repeat(65_536),
      stampKey,
      ephemeralSecret,
    }),
  ).toThrow('network UTF-8 encoding does not fit u16')
})

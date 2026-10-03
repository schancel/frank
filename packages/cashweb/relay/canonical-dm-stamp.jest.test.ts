import * as cryptoBox from '@frank/crypto-box'
import {
  fromHex,
  toHex,
  parseFrame,
  verifyPreviewDirectoryEvidence,
} from '../../frank-codec/src'
import corpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import {
  canonicalStampDestination,
  createCanonicalStampProof,
  verifyCanonicalStampProof,
  paymentCommitment,
  recipientPayloadDigest,
} from './canonical-dm-stamp'

const input = () => ({
  network: corpus.network,
  stampKey: { keyType: 1, keyBytes: fromHex(corpus.stamp_key) },
  ephemeralPoint: fromHex(corpus.ephemeral_point),
  sharedPoint: fromHex(corpus.shared_point),
  dleqProof: fromHex(corpus.proof),
})
afterEach(() => jest.restoreAllMocks())

test('shared exact suite1 fixture opens through crypto-box and binds directory/T3/T4 bytes', () => {
  const v = corpus.runtime_case
  const directory = verifyPreviewDirectoryEvidence(
    fromHex(v.attestation),
    corpus.network,
  )
  expect(toHex(directory.statementFrame.frame)).toBe(v.statement)
  expect(toHex(directory.statementHash)).toBe(v.t1)
  const result = parseFrame(fromHex(v.delivery))
  if (result.kind !== 'parsed' || result.typed?.type !== 1)
    throw new Error('delivery')
  const payload = result.typed.payloadFrame
  if (payload.typed?.type !== 5 || payload.typed.schemaVersion !== 2)
    throw new Error('payload')
  expect(toHex(payload.frame)).toBe(v.payload)
  expect(toHex(recipientPayloadDigest(corpus.network, payload.frame))).toBe(
    v.t3,
  )
  expect(toHex(paymentCommitment(fromHex(v.t3), 0))).toBe(v.t4)
  const opened = cryptoBox.open({
    envelope: payload.typed.cryptoBoxEnvelope,
    recipientPrivateKey: fromHex(v.message_secret_test_only),
    senderPublicKey: directory.statement.preview.messageDhKey.keyBytes,
    context: fromHex(v.context),
  })
  if (!opened.ok) throw new Error(opened.error.code)
  expect(toHex(opened.value)).toBe(v.content)
  const content = parseFrame(opened.value)
  expect(content.kind === 'parsed' && content.typed?.type).toBe(6)
  const badContext = fromHex(v.context)
  badContext[badContext.length - 1] ^= 1
  expect(
    cryptoBox.open({
      envelope: payload.typed.cryptoBoxEnvelope,
      recipientPrivateKey: fromHex(v.message_secret_test_only),
      senderPublicKey: directory.statement.preview.messageDhKey.keyBytes,
      context: badContext,
    }).ok,
  ).toBe(false)
  // Separate parses above are fixture checks, not the held #789 aggregate-budget proof.
})

test('runtime writer reproduces independently published T3c with mocked CSPRNG', () => {
  const draws = [
    fromHex(corpus.ephemeral_secret_test_only),
    fromHex(corpus.nonce_test_only),
  ]
  jest.spyOn(cryptoBox, 'randomBytes').mockImplementation(() => {
    const next = draws.shift()
    if (!next) throw new Error('unexpected entropy')
    return new Uint8Array(next)
  })
  const proof = createCanonicalStampProof(input())
  expect(toHex(proof.ephemeralPoint)).toBe(corpus.ephemeral_point)
  expect(toHex(proof.sharedPoint)).toBe(corpus.shared_point)
  expect(toHex(proof.dleqProof)).toBe(corpus.proof)
  verifyCanonicalStampProof({ ...input(), ...proof })
  expect(draws).toHaveLength(0)
})

test('T3a matches independent destinations without reducing the tweak', () => {
  for (const vector of corpus.destinations) {
    const result = canonicalStampDestination({
      ...input(),
      childIndex: vector.index,
    })
    expect(toHex(result.address)).toBe(vector.address)
    if ('public_key' in vector)
      expect(toHex(result.publicKey)).toBe(vector.public_key)
  }
})

test('rejection-sampled stamp entropy and proof nonce copies are wiped', () => {
  const draws = [
    new Uint8Array(32),
    fromHex(corpus.ephemeral_secret_test_only),
    fromHex(corpus.nonce_test_only),
  ]
  const consumed: Uint8Array[] = []
  jest.spyOn(cryptoBox, 'randomBytes').mockImplementation(() => {
    const next = draws.shift()
    if (!next) throw new Error('unexpected entropy')
    consumed.push(next)
    return next
  })
  const proof = createCanonicalStampProof(input())
  verifyCanonicalStampProof({ ...input(), ...proof })
  expect(consumed).toHaveLength(3)
  expect(consumed.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
})

test.each(corpus.hostile)('rejects shared hostile case %s', name => {
  const value = input()
  switch (name) {
    case 'wrong-network':
      value.network = 'other'
      break
    case 'wrong-stamp-key':
      value.stampKey.keyBytes = value.ephemeralPoint
      break
    case 'wrong-ephemeral-point':
      value.ephemeralPoint = value.stampKey.keyBytes
      break
    case 'wrong-shared-point':
      value.sharedPoint = value.ephemeralPoint
      break
    case 'changed-proof':
      value.dleqProof[0] ^= 1
      break
    case 'zero-challenge':
      value.dleqProof.fill(0, 0, 32)
      break
    case 'order-challenge':
      value.dleqProof.set(
        fromHex(
          'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
        ),
      )
      break
    case 'zero-response':
      value.dleqProof.fill(0, 32)
      break
    case 'short-proof':
      value.dleqProof = value.dleqProof.slice(1)
      break
    case 'uncompressed-point':
      value.ephemeralPoint = new Uint8Array(65)
      value.ephemeralPoint[0] = 4
      break
    case 'invalid-point':
      value.sharedPoint.fill(0)
      break
    case 'child-index-overflow':
      expect(() =>
        canonicalStampDestination({ ...value, childIndex: 2147483648 }),
      ).toThrow()
      return
    default:
      throw new Error(`missing hostile test: ${name}`)
  }
  expect(() => verifyCanonicalStampProof(value)).toThrow()
})

test('T3/T4 bind exact frame bytes, network and child index', () => {
  const frame = fromHex('46524e4b0100000001a0')
  const digest = recipientPayloadDigest('monad', frame)
  expect(toHex(recipientPayloadDigest('other', frame))).not.toBe(toHex(digest))
  const changed = new Uint8Array(frame)
  changed[changed.length - 1] ^= 1
  expect(toHex(recipientPayloadDigest('monad', changed))).not.toBe(
    toHex(digest),
  )
  expect(toHex(paymentCommitment(digest, 0))).not.toBe(
    toHex(paymentCommitment(digest, 1)),
  )
})

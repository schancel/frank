// Independent oracle: Node/OpenSSL SHA-256 and a bit-string/number Bech32m
// implementation. This file imports no Frank package or production hash/codec.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const hex = bytes => bytes.toString('hex')
const hash = bytes => createHash('sha256').update(bytes).digest()
const ascii = text => Buffer.from(text, 'ascii')
const join = (...parts) => Buffer.concat(parts)
const tag = text => join(ascii(text), Buffer.from([0]))
const u16 = value => Buffer.from([value >>> 8, value & 255])
const field = text => join(u16(text.length), ascii(text))

function bech32m(hrp, bytes) {
  const bits = [...bytes]
    .map(byte => byte.toString(2).padStart(8, '0'))
    .join('')
  const words = bits
    .padEnd(Math.ceil(bits.length / 5) * 5, '0')
    .match(/.{5}/g)
    .map(word => parseInt(word, 2))
  const chars = [...hrp].map(char => char.charCodeAt(0))
  const expanded = [
    ...chars.map(char => char >>> 5),
    0,
    ...chars.map(char => char & 31),
  ]
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ]
  let check = 1
  for (const word of [...expanded, ...words, 0, 0, 0, 0, 0, 0]) {
    const high = check >>> 25
    check = ((check & 0x1ffffff) << 5) ^ word
    generators.forEach((generator, bit) => {
      if ((high >>> bit) & 1) check ^= generator
    })
  }
  check ^= 0x2bc830a3
  for (let shift = 25; shift >= 0; shift -= 5)
    words.push((check >>> shift) & 31)
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  return `${hrp}1${words.map(word => alphabet[word]).join('')}`
}

function vector(root, name) {
  const validationPreimage = join(tag('frank/master-validation/v1'), root)
  const master = join(root, hash(validationPreimage))
  const fingerprintPreimage = join(
    tag('frank/recovery-fingerprint/v1'),
    field('codex32-master-v1'),
    field('frank-domain-roots-v1'),
    master,
  )
  const fingerprint = hash(fingerprintPreimage)
  const retirementPreimage = join(tag('frank/root-retirement/v1'), root)
  const identityPreimage = join(
    tag('frank/recovery-identity/v1'),
    u16(1),
    u16(1),
    fingerprint,
  )
  const descriptorPayload = join(Buffer.from([1]), u16(1), u16(1), fingerprint)
  const changedFormatPreimage = join(
    tag('frank/recovery-fingerprint/v1'),
    field('codex32-master-v2'),
    field('frank-domain-roots-v1'),
    master,
  )
  const changedRegistryPreimage = join(
    tag('frank/recovery-fingerprint/v1'),
    field('codex32-master-v1'),
    field('frank-domain-roots-v2'),
    master,
  )
  return {
    name,
    root: hex(root),
    master: hex(master),
    validationPreimage: hex(validationPreimage),
    fingerprintPreimage: hex(fingerprintPreimage),
    fingerprint: hex(fingerprint),
    retirementPreimage: hex(retirementPreimage),
    masterRetirementId: hex(hash(retirementPreimage)),
    identityPreimage: hex(identityPreimage),
    recoveryIdentityCommitment: hex(hash(identityPreimage)),
    descriptorPayload: hex(descriptorPayload),
    frankdesc: bech32m('frankdesc', descriptorPayload),
    frankrec: bech32m('frankrec', fingerprint),
    // Hypothetical unallocated identifiers prove preimage separation, not API support.
    changedFormatFingerprint: hex(hash(changedFormatPreimage)),
    changedRegistryFingerprint: hex(hash(changedRegistryPreimage)),
    changedFormatIdentity: hex(
      hash(
        join(tag('frank/recovery-identity/v1'), u16(2), u16(1), fingerprint),
      ),
    ),
    changedRegistryIdentity: hex(
      hash(
        join(tag('frank/recovery-identity/v1'), u16(1), u16(2), fingerprint),
      ),
    ),
  }
}

const vectors = [
  vector(Buffer.alloc(32), 'zero'),
  vector(
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
    'sequence',
  ),
]
if (process.argv.includes('--emit')) {
  process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`)
} else {
  const frozen = JSON.parse(
    readFileSync(
      new URL('../vectors/public-recovery-v1.json', import.meta.url),
      'utf8',
    ),
  )
  assert.deepEqual(vectors, frozen)
  console.log(
    `Public recovery vectors: ${vectors.length} independent preimage, digest and encoding cases passed`,
  )
}

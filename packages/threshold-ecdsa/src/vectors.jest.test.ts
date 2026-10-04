/**
 * Fixed test vectors. `test-vectors/threshold_ecdsa.json` records complete
 * protocol transcripts produced with a seeded byte stream in place of a
 * CSPRNG, so an independent implementation can be checked message by message.
 * This suite regenerates every transcript and compares.
 *
 * To rewrite the file after an intentional wire change:
 *   UPDATE_VECTORS=1 yarn jest src/vectors
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  completeAdaptorSignature,
  generateAdaptorSecret,
  type AdaptorPoint,
  type AdaptorSecret,
  type AdaptorSecretProof,
} from '@frank/adaptor-signatures'

import {
  describeKeyShare,
  exportKeyShare,
  exportKeyShareRecord,
  keygenStep,
  signStep,
  startKeygen,
  startSign,
  tweakPublicKey,
  type KeyShare,
} from './index.js'
import {
  ascii,
  drive,
  fromHex,
  hex,
  must,
  seededRandom,
} from './test-support.js'

const VECTOR_PATH = join(
  __dirname,
  '..',
  'test-vectors',
  'threshold_ecdsa.json',
)

interface SignCase {
  name: string
  initiator: 'keygen-initiator' | 'keygen-responder'
  sessionId: string
  digest: string
  tweakCommitment: string | null
  adaptor: { secret: string; point: string; proof: string } | null
  initiatorRng: string
  responderRng: string
  messages: string[]
  publicKey: string
  address: string
  signature: string | null
  recovery: number | null
  adaptorSignature: string | null
  completedSignature: string | null
}

interface Vectors {
  description: string
  rng: string
  keygen: {
    sessionId: string
    initiatorId: string
    responderId: string
    initiatorSeed: string
    responderSeed: string
    initiatorRng: string
    responderRng: string
    messages: string[]
    publicKey: string
    address: string
    keyId: string
    initiatorRecord: string
    responderRecord: string
    initiatorShare: string
    responderShare: string
  }
  tweaks: {
    publicKey: string
    commitment: string
    tweak: string
    tweakedPublicKey: string
    address: string
  }[]
  signing: SignCase[]
}

function filled(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte)
}

function runKeygen(): { vector: Vectors['keygen']; a: KeyShare; b: KeyShare } {
  const sessionId = filled(0x11)
  const initiatorId = ascii('alice')
  const responderId = ascii('bob')
  const initiatorSeed = filled(0xa1)
  const responderSeed = filled(0xb2)
  const trace = drive(
    startKeygen({
      role: 'initiator',
      sessionId,
      localId: initiatorId,
      peerId: responderId,
      secretSeed: initiatorSeed,
      randomBytes: seededRandom('keygen/initiator'),
    }),
    startKeygen({
      role: 'responder',
      sessionId,
      localId: responderId,
      peerId: initiatorId,
      secretSeed: responderSeed,
      randomBytes: seededRandom('keygen/responder'),
    }),
    keygenStep,
  )
  const a = trace.initiatorResult
  const b = trace.responderResult
  if (a === null || b === null) throw new Error('key generation did not finish')
  const info = must(describeKeyShare(a))
  return {
    a,
    b,
    vector: {
      sessionId: hex(sessionId),
      initiatorId: hex(initiatorId),
      responderId: hex(responderId),
      initiatorSeed: hex(initiatorSeed),
      responderSeed: hex(responderSeed),
      initiatorRng: 'keygen/initiator',
      responderRng: 'keygen/responder',
      messages: trace.messages.map(hex),
      publicKey: hex(info.publicKey),
      address: hex(info.address),
      keyId: hex(info.keyId),
      initiatorRecord: hex(must(exportKeyShareRecord(a))),
      responderRecord: hex(must(exportKeyShareRecord(b))),
      initiatorShare: hex(must(exportKeyShare(a))),
      responderShare: hex(must(exportKeyShare(b))),
    },
  }
}

interface SignPlan {
  name: string
  initiator: SignCase['initiator']
  sessionByte: number
  digestByte: number
  tweakByte: number | null
  adaptor: boolean
}

const PLANS: SignPlan[] = [
  {
    name: 'plain',
    initiator: 'keygen-initiator',
    sessionByte: 0x21,
    digestByte: 0x31,
    tweakByte: null,
    adaptor: false,
  },
  {
    name: 'plain, roles swapped, tweaked key',
    initiator: 'keygen-responder',
    sessionByte: 0x22,
    digestByte: 0x32,
    tweakByte: 0x42,
    adaptor: false,
  },
  {
    name: 'adaptor',
    initiator: 'keygen-initiator',
    sessionByte: 0x23,
    digestByte: 0x33,
    tweakByte: null,
    adaptor: true,
  },
  {
    name: 'adaptor, roles swapped, tweaked key',
    initiator: 'keygen-responder',
    sessionByte: 0x24,
    digestByte: 0x34,
    tweakByte: 0x44,
    adaptor: true,
  },
]

function runSign(
  plan: SignPlan,
  a: KeyShare,
  b: KeyShare,
  recorded: SignCase['adaptor'],
): SignCase {
  const sessionId = filled(plan.sessionByte)
  const digest = filled(plan.digestByte)
  const tweakCommitment =
    plan.tweakByte === null ? undefined : filled(plan.tweakByte)
  let adaptor = recorded
  if (plan.adaptor && adaptor === null) {
    // The proof of knowledge in @frank/adaptor-signatures uses ambient
    // randomness, so the triple is an input of the vector, not an output.
    const material = must(
      generateAdaptorSecret(seededRandom(`adaptor/${plan.name}`)),
    )
    adaptor = {
      secret: hex(material.secret),
      point: hex(material.point),
      proof: hex(material.proof),
    }
  }
  const adaptorInput =
    adaptor === null
      ? undefined
      : {
          point: fromHex(adaptor.point) as AdaptorPoint,
          proof: fromHex(adaptor.proof) as AdaptorSecretProof,
        }
  const initiatorShare = plan.initiator === 'keygen-initiator' ? a : b
  const responderShare = plan.initiator === 'keygen-initiator' ? b : a
  const initiatorRng = `sign/${plan.name}/initiator`
  const responderRng = `sign/${plan.name}/responder`
  const trace = drive(
    startSign({
      keyShare: initiatorShare,
      role: 'initiator',
      sessionId,
      digest,
      tweakCommitment,
      adaptor: adaptorInput,
      randomBytes: seededRandom(initiatorRng),
    }),
    startSign({
      keyShare: responderShare,
      role: 'responder',
      sessionId,
      digest,
      tweakCommitment,
      adaptor: adaptorInput,
      randomBytes: seededRandom(responderRng),
    }),
    signStep,
  )
  const result = trace.initiatorResult
  if (result === null || trace.responderResult === null) {
    throw new Error('signing did not finish')
  }
  expect(trace.responderResult).toEqual(result)
  let completed: string | null = null
  if (result.kind === 'adaptor-signature' && adaptor !== null) {
    completed = hex(
      must(
        completeAdaptorSignature({
          publicKey: result.publicKey,
          adaptorPoint: fromHex(adaptor.point) as AdaptorPoint,
          adaptorProof: fromHex(adaptor.proof) as AdaptorSecretProof,
          digest,
          signature: result.adaptorSignature,
          secret: fromHex(adaptor.secret) as AdaptorSecret,
        }),
      ),
    )
  }
  return {
    name: plan.name,
    initiator: plan.initiator,
    sessionId: hex(sessionId),
    digest: hex(digest),
    tweakCommitment: tweakCommitment ? hex(tweakCommitment) : null,
    adaptor,
    initiatorRng,
    responderRng,
    messages: trace.messages.map(hex),
    publicKey: hex(result.publicKey),
    address: hex(result.address),
    signature: result.kind === 'signature' ? hex(result.signature) : null,
    recovery: result.kind === 'signature' ? result.recovery : null,
    adaptorSignature:
      result.kind === 'adaptor-signature' ? hex(result.adaptorSignature) : null,
    completedSignature: completed,
  }
}

function build(previous: Vectors | null): Vectors {
  const keygen = runKeygen()
  const publicKey = fromHex(keygen.vector.publicKey)
  const tweaks = [0x42, 0x44, 0x00, 0xff].map(byte => {
    const commitment = filled(byte)
    const tweaked = must(tweakPublicKey(publicKey, commitment))
    return {
      publicKey: keygen.vector.publicKey,
      commitment: hex(commitment),
      tweak: hex(tweaked.tweak),
      tweakedPublicKey: hex(tweaked.publicKey),
      address: hex(tweaked.address),
    }
  })
  const signing = PLANS.map(plan =>
    runSign(
      plan,
      keygen.a,
      keygen.b,
      previous?.signing.find(entry => entry.name === plan.name)?.adaptor ??
        null,
    ),
  )
  return {
    description:
      'Two-party threshold ECDSA transcripts for @frank/threshold-ecdsa. All keys here are public test material.',
    rng: 'Each party draws from the stream SHA256(SHA256("test-vector-rng") || SHA256(label) || counter32be), blocks concatenated, consumed in call order.',
    keygen: keygen.vector,
    tweaks,
    signing,
  }
}

describe('fixed test vectors', () => {
  it('reproduces every recorded transcript byte for byte', () => {
    if (process.env.UPDATE_VECTORS === '1') {
      writeFileSync(VECTOR_PATH, `${JSON.stringify(build(null), null, 2)}\n`)
    }
    const recorded = JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as Vectors
    const rebuilt = build(recorded)
    expect(rebuilt.keygen).toEqual(recorded.keygen)
    expect(rebuilt.tweaks).toEqual(recorded.tweaks)
    expect(rebuilt.signing).toEqual(recorded.signing)
    expect(recorded.keygen.messages).toHaveLength(7)
    for (const entry of recorded.signing) {
      expect(entry.messages).toHaveLength(5)
    }
  })
})

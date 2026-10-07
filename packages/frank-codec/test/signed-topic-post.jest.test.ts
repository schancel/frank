import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  encodeForumPost,
  verifyTopicPostAuthor,
  topicPostSignatureDigest,
  validateFrame,
  defaultContext,
  addressFromCompressedPubkey,
  toHex,
} from '../src'

describe('signed topic post author verification', () => {
  const privateKey = new Uint8Array(32).fill(0x42)
  const compressedPubKey = secp256k1.getPublicKey(privateKey, true)
  const expectedAddress = addressFromCompressedPubkey(compressedPubKey)

  function signPost(
    topic: string,
    network = 'monad-testnet',
    message = 'Hello signed world',
    parentHash?: Uint8Array,
  ) {
    const authored = { seconds: 1700000000n, nanoseconds: 0 }
    const entries = [{ title: 'Title', message }]

    // Encode temporary unsigned post to get exact body bytes
    const unsignedFrame = encodeForumPost({
      network,
      topic,
      parentHash,
      authored,
      entries,
    })
    const parsedUnsigned = validateFrame(unsignedFrame, defaultContext())
    if (parsedUnsigned.kind !== 'parsed') throw new Error('parse unsigned failed')
    const typedUnsigned = parsedUnsigned.typed as any

    const digest = topicPostSignatureDigest(
      network,
      topic,
      typedUnsigned.body,
      parentHash,
    )
    const sig = secp256k1.sign(digest, privateKey, { lowS: true })
    const derSig = sig.toDERRawBytes()

    const signedFrame = encodeForumPost({
      network,
      topic,
      parentHash,
      authored,
      entries,
      from: { keyType: 1, keyBytes: compressedPubKey },
      signature: derSig,
    })

    return { signedFrame, digest, derSig }
  }

  it('encodes and verifies author identity from Algorithm 1 signature', () => {
    const { signedFrame } = signPost('general')
    const parsed = validateFrame(signedFrame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    expect(post.type).toBe(9)
    expect(post.from).toBeDefined()
    expect(post.signature).toBeDefined()

    const verifiedAddr = verifyTopicPostAuthor(post)
    expect(verifiedAddr).toBeDefined()
    expect(toHex(verifiedAddr!)).toBe(toHex(expectedAddress))
  })

  it('rejects tampered topic', () => {
    const { signedFrame } = signPost('general')
    const parsed = validateFrame(signedFrame, defaultContext())
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    const tampered = { ...post, topic: 'other-topic' }
    expect(verifyTopicPostAuthor(tampered)).toBeUndefined()
  })

  it('rejects tampered network', () => {
    const { signedFrame } = signPost('general')
    const parsed = validateFrame(signedFrame, defaultContext())
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    const tampered = { ...post, network: 'different-net' }
    expect(verifyTopicPostAuthor(tampered)).toBeUndefined()
  })

  it('rejects tampered body', () => {
    const { signedFrame } = signPost('general')
    const parsed = validateFrame(signedFrame, defaultContext())
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    const tamperedBody = new Uint8Array(post.body)
    tamperedBody[0] ^= 0xff
    const tampered = { ...post, body: tamperedBody }
    expect(verifyTopicPostAuthor(tampered)).toBeUndefined()
  })

  it('rejects tampered parentHash', () => {
    const parent = new Uint8Array(32).fill(0xaa)
    const { signedFrame } = signPost('general', 'monad-testnet', 'reply', parent)
    const parsed = validateFrame(signedFrame, defaultContext())
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    const tampered = { ...post, parentHash: new Uint8Array(32).fill(0xbb) }
    expect(verifyTopicPostAuthor(tampered)).toBeUndefined()
  })

  it('returns undefined for post without from or signature', () => {
    const unsignedFrame = encodeForumPost({
      network: 'monad-testnet',
      topic: 'general',
      authored: { seconds: 1n, nanoseconds: 0 },
      entries: [{ title: 'Plain' }],
    })
    const parsed = validateFrame(unsignedFrame, defaultContext())
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    expect(verifyTopicPostAuthor(post)).toBeUndefined()
  })
})

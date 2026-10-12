// Offline structural size proof; imports the separately reviewed frozen codec artifact.
// Padded worst-case raw bytes/ciphertext below are sizing fixtures, never executable claims.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PublicKey, PACKET_DATA_SIZE } from '@solana/web3.js'
import { getBase58Encoder } from '@solana/codecs-strings'
const [manifestPath, codecTreeInput] = process.argv.slice(2)
assert(manifestPath && codecTreeInput, 'Usage: node --import tsx wire-size-proof.mjs PUBLIC_MANIFEST FROZEN_CODEC_TREE')
const codecTree = resolve(codecTreeInput)
const frozen = 'e5694dbba5791d6757618e0bcacf27cfd81ea004'
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codecTree, encoding: 'utf8' }).trim(), frozen)
const codec = await import(pathToFileURL(`${codecTree}/packages/frank-codec/src/index.ts`).href)
const { encodeStealthAssetMessageItem } = await import(pathToFileURL(`${codecTree}/packages/frank-codec/src/stealth-assets.ts`).href)
const { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES, MAX_RELAY_BODY_BYTES } = await import('../../cashweb/relay/message-limits.ts')
const { encodeEnvelope } = await import('../../crypto-box/src/envelope.ts')
const { MAX_PADDING, KEM_SECP256K1, SUITE_AUTH_XCHACHA } = await import('../../crypto-box/src/ids.ts')
const source = JSON.parse(await readFile(manifestPath, 'utf8'))
assert(source.length >= 4)
const pub = value => new PublicKey(value).toBytes()
const entry = row => ({
  derivationScheme: 2,
  recipientSpendKey: { keyType: 2, keyBytes: pub(row.original.destination.recipientPoint) },
  derivationContext: codec.encodeExperimentalSolanaStealthContext({ cryptoOperationId: Uint8Array.from(Buffer.from(row.context.cryptoOperationId32, 'hex')), memberIndex: row.context.memberIndex, derivationContext: Uint8Array.from(Buffer.from(row.context.derivationContext32, 'hex')) }),
  ...(row.asset.kind === 'spl' ? { tokenProgram: pub(row.asset.program) } : {}),
  transfer: { networkTag: row.chainIdentifier, txId: getBase58Encoder().encode(row.original.signature), destination: pub(row.original.destination.destinationOwner), value: BigInt(row.original.amount), ...(row.asset.kind === 'spl' ? { token: pub(row.asset.mint) } : {}), stealthMetadata: { ephemeralPubKey: { keyType: 2, keyBytes: pub(row.original.destination.ephemeralPoint) } }, rawTx: Uint8Array.from(Buffer.from(row.original.transaction, 'base64')) },
})
for (const row of source) {
  const projected = codec.projectExperimentalSolanaStealthTransfer(entry(row))
  assert.equal(projected.recipientAmount, BigInt(row.original.amount))
  assert(projected.rawSignedTransaction.length <= PACKET_DATA_SIZE)
}
const frame = (typeId, payload, schemaVersion = 1) => codec.encodeFrame({ typeId, schemaVersion, minReaderVersion: schemaVersion }, payload)
const m = fields => new Map(fields)
const worst = Array.from({ length: codec.MAX_PAYMENT_MEMBERS }, (_, index) => {
  const item = entry(source.find(row => row.asset.kind === 'spl'))
  item.derivationContext = codec.encodeExperimentalSolanaStealthContext({ cryptoOperationId: new Uint8Array(32), memberIndex: index, derivationContext: new Uint8Array(32).fill(1) })
  item.transfer.networkTag = 'solana-mainnet'
  item.transfer.value = (1n << 64n) - 1n
  item.transfer.rawTx = new Uint8Array(PACKET_DATA_SIZE)
  return item
})
// The existing schema permits16 transfers per item. Four items carry64 members.
const items = []
for (let index = 0; index < worst.length; index += 16) items.push(encodeStealthAssetMessageItem({ transfers: worst.slice(index, index + 16), memo: 'm'.repeat(1024) }))
items.push(frame(17, m([[0, 't'.repeat(codec.MAX_TEXT_STRING_BYTES)]])))
const revision = frame(8, m([[0, 'frank'], [1, items]]))
const plaintext = frame(6, m([[0, 'solana-mainnet'], [1, new Uint8Array(16)], [2, revision], [3, codec.messageContentDigest(revision)], [4, new Uint8Array(16)], [5, 'c'.repeat(256)]]))
assert.equal(codec.parseFrame(plaintext).kind, 'parsed')
assert(plaintext.length <= MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES)
const ciphertextBytes = 4 + plaintext.length + MAX_PADDING + 16
assert(ciphertextBytes <= codec.MAX_CIPHERTEXT_BYTES)
const point = Uint8Array.from(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'))
const box = encodeEnvelope(SUITE_AUTH_XCHACHA, KEM_SECP256K1, new Uint8Array(32), point, new Uint8Array(ciphertextBytes))
assert(box.length <= codec.MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES)
const account = m([[0, 1], [1, point]])
const proof = new Uint8Array(64); proof[31] = proof[63] = 1
const encrypted = frame(5, m([[0, 'solana-mainnet'], [1, account], [2, account], [3, SUITE_AUTH_XCHACHA], [4, box], [5, point], [6, point], [7, proof]]), 2)
const stamp = m([[0, 0], [1, new Uint8Array(128)], [2, (1n << 64n) - 1n], [3, new Uint8Array(128)], [4, new Uint8Array(32)], [5, 4294967295], [6, new Uint8Array(16384)]])
const delivery = frame(1, m([[0, 'solana-mainnet'], [1, account], [2, encrypted], [3, codec.recipientPayloadDigest('solana-mainnet', encrypted)], [4, [stamp]], [5, account], [6, proof]]), 2)
assert.equal(codec.parseFrame(delivery).kind, 'parsed')
assert(delivery.length <= codec.MAX_DIRECT_MESSAGE_FRAME_BYTES)
assert(delivery.length * 2 + 128 * 1024 + 1024 <= MAX_RELAY_BODY_BYTES)
console.log(JSON.stringify({ codecCommit: frozen, actualMembersProjected: source.length, worstMembers: worst.length, financialItems: 4, maximumTextBytes: codec.MAX_TEXT_STRING_BYTES, memoBytesPerItem: 1024, maximumCryptoPadding: MAX_PADDING, plaintextBytes: plaintext.length, ciphertextBytes, cryptoBoxBytes: box.length, deliveryFrameBytes: delivery.length, relayHexAndHeadroomBytes: delivery.length * 2 + 128 * 1024 + 1024, relayBodyCap: MAX_RELAY_BODY_BYTES }))

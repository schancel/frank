// THROWAWAY spike script. Exercises the FULL encrypt -> commit -> decrypt ->
// re-verify pipeline used by sender.ts/receiver.ts, WITHOUT touching the
// chain. This only proves the crypto+commitment logic is correct; it is NOT
// a substitute for a real on-chain tx (see spike/sender.ts for that).
import fs from 'node:fs'
import path from 'node:path'
import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'
import { PayloadConstructor } from '../app/src/cashweb/relay/crypto'
import { computeCommitment } from './lib/commitment'

const DATA_DIR = path.resolve(__dirname, 'data')
const ECDH_SALT = Buffer.from('frank-spike-demo-ecdh-salt')

const message = process.argv[2] ?? 'dry run: no real chain tx, crypto only'

const senderMsgKeyRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'sender-messaging-key.json'), 'utf8'),
)
const recipientMsgKeyRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'recipient-messaging-key.json'), 'utf8'),
)

const senderPriv = PrivateKey.fromWIF(senderMsgKeyRaw.privateKeyWIF)
const recipientPriv = PrivateKey.fromWIF(recipientMsgKeyRaw.privateKeyWIF)
const recipientPub = PublicKey.fromBuffer(
  Buffer.from(recipientMsgKeyRaw.publicKeyCompressedHex, 'hex'),
)
const senderPub = PublicKey.fromBuffer(Buffer.from(senderMsgKeyRaw.publicKeyCompressedHex, 'hex'))

const pc = new PayloadConstructor({ networkName: 'livenet' })

// sender side
const sharedA = pc.constructSharedKey(senderPriv, recipientPub, ECDH_SALT)
const ciphertext = pc.encrypt(sharedA, Buffer.from(message, 'utf8'))
const timestampSeconds = Math.floor(Date.now() / 1000)
const h_m_sent = computeCommitment(message, senderPriv.toPublicKey().toBuffer(), timestampSeconds)

// simulate calldata being read back from chain (bytes are just h_m_sent)
const h_m_onchain_simulated = h_m_sent

// receiver side
const sharedB = pc.constructSharedKey(recipientPriv, senderPub, ECDH_SALT)
const decrypted = Buffer.from(pc.decrypt(sharedB, ciphertext)).toString('utf8')
const h_m_recomputed = computeCommitment(
  decrypted,
  Buffer.from(senderMsgKeyRaw.publicKeyCompressedHex, 'hex'),
  timestampSeconds,
)

console.log('message (original) :', message)
console.log('message (decrypted):', decrypted)
console.log('decrypt roundtrip OK:', decrypted === message)
console.log('h_m (sent)       :', h_m_sent)
console.log('h_m (simulated onchain read):', h_m_onchain_simulated)
console.log('h_m (recomputed) :', h_m_recomputed)
console.log('commitment match:', h_m_recomputed === h_m_onchain_simulated)
console.log('\n[NOTE] This is a crypto-only dry run. No chain tx was sent or read.')

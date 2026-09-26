// THROWAWAY spike script.
//
// Generates:
//  - two "messaging identity" secp256k1 keypairs (sender + recipient), using
//    bitcore-lib-xpi (this repo's existing dep) purely for key generation —
//    these are the keys plugged into the real app/src/cashweb/relay/crypto.ts
//    ECDH code for E2E encryption of the message payload.
//  - one "chain wallet" secp256k1 keypair (via ethers.Wallet) used to
//    actually sign & send the real Monad testnet burn transaction.
//
// These are deliberately separate identities for this spike — in the real
// system they might be related, but that's out of scope here.
//
// Run once: npx tsx spike/keygen.ts
// Idempotent-ish: refuses to overwrite existing files unless --force is passed.
import fs from 'node:fs'
import path from 'node:path'
import { PrivateKey } from 'bitcore-lib-xpi'
import { Wallet } from 'ethers'

const DATA_DIR = path.resolve(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const force = process.argv.includes('--force')

function writeIfAbsent(filePath: string, content: object) {
  if (fs.existsSync(filePath) && !force) {
    console.log(`skip (exists): ${filePath}`)
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2))
  console.log(`wrote: ${filePath}`)
  return content
}

// --- messaging identities (bitcore-lib-xpi secp256k1, for ECDH via crypto.ts) ---
const senderMsgKey = new PrivateKey()
const recipientMsgKey = new PrivateKey()

// NOTE: private keys are stored as WIF, not raw hex. bitcore's
// PrivateKey.fromBuffer() on a raw 32-byte buffer defaults `compressed:
// false`, which silently produces a DIFFERENT (uncompressed, 65-byte)
// public key than the one generated here (compressed, 33-byte) — breaking
// the commitment hash match between sender and receiver. WIF encodes the
// compression flag explicitly, so PrivateKey.fromWIF() round-trips correctly.
const senderMsg = writeIfAbsent(path.join(DATA_DIR, 'sender-messaging-key.json'), {
  privateKeyWIF: senderMsgKey.toWIF(),
  publicKeyCompressedHex: senderMsgKey.toPublicKey().toBuffer().toString('hex'),
})
const recipientMsg = writeIfAbsent(
  path.join(DATA_DIR, 'recipient-messaging-key.json'),
  {
    privateKeyWIF: recipientMsgKey.toWIF(),
    publicKeyCompressedHex: recipientMsgKey
      .toPublicKey()
      .toBuffer()
      .toString('hex'),
  },
)

// --- chain wallet (ethers, used to sign the real Monad testnet tx) ---
const chainWalletPath = path.join(DATA_DIR, 'chain-wallet.json')
let chainWallet
if (fs.existsSync(chainWalletPath) && !force) {
  chainWallet = JSON.parse(fs.readFileSync(chainWalletPath, 'utf8'))
  console.log(`skip (exists): ${chainWalletPath}`)
} else {
  const w = Wallet.createRandom()
  chainWallet = { address: w.address, privateKey: w.privateKey }
  fs.writeFileSync(chainWalletPath, JSON.stringify(chainWallet, null, 2))
  console.log(`wrote: ${chainWalletPath}`)
}

console.log('\n=== Messaging identities (for E2E encryption via crypto.ts) ===')
console.log('sender pubkey   :', senderMsg.publicKeyCompressedHex)
console.log('recipient pubkey:', recipientMsg.publicKeyCompressedHex)

console.log('\n=== Chain wallet (for signing the real Monad testnet burn tx) ===')
console.log('address:', chainWallet.address)
console.log(
  '\n>>> This wallet needs testnet MON before spike/sender.ts can send a real tx. <<<',
)
console.log('Fund it via a Monad testnet faucet, then re-run spike/check-balance.ts')

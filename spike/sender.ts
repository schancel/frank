// THROWAWAY spike script — sender side of the "Stamp" burn-to-speak demo.
//
// 1. Encrypts a plaintext message for the recipient using the REAL
//    app/src/cashweb/relay/crypto.ts ECDH+AES-CBC code (PayloadConstructor).
// 2. Computes h_m = keccak256(message || senderPubKey || timestamp) — see
//    spike/lib/commitment.ts for the exact domain.
// 3. Sends a REAL Monad testnet tx: small MON value, to the fixed burn
//    address, with h_m as calldata. Waits for confirmation. Prints tx hash.
// 4. Writes the encrypted payload + metadata to spike/data/payload.json —
//    this stands in for "out-of-band delivery" since there's no relay server
//    in this spike; the receiver script reads this same file.
//
// Usage: npx tsx spike/sender.ts "your message here"
import fs from 'node:fs'
import path from 'node:path'
import { JsonRpcProvider, Wallet as ChainWallet, formatEther } from 'ethers'
import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'
import { PayloadConstructor } from '../app/src/cashweb/relay/crypto'
import { requireEnv, ENV_SOURCE } from './lib/env'
import { computeCommitment } from './lib/commitment'

const DATA_DIR = path.resolve(__dirname, 'data')
const BURN_VALUE_MON = '0.0001'
// Salt for the ECDH shared-key HMAC. Domain separation doesn't matter for a
// spike, just needs to match between sender and receiver.
const ECDH_SALT = Buffer.from('frank-spike-demo-ecdh-salt')

async function main() {
  const message = process.argv[2]
  if (!message) {
    console.error('Usage: npx tsx spike/sender.ts "your message here"')
    process.exit(1)
  }

  console.log('env loaded from:', ENV_SOURCE)
  const rpcUrl = requireEnv('MONAD_TESTNET_HTTP_RPC_URL')
  // Not present in the real .env (only documented in .env.example) — use the
  // documented ticket #7 value as fallback, per spike instructions.
  const burnAddress = requireEnv(
    'MONAD_STAMP_BURN_ADDRESS',
    '0x000000000000000000000000000000000000dEaD',
  )

  const senderMsgKeyRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'sender-messaging-key.json'), 'utf8'),
  )
  const recipientMsgKeyRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'recipient-messaging-key.json'), 'utf8'),
  )
  const chainWalletRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'chain-wallet.json'), 'utf8'),
  )

  const senderMsgPriv = PrivateKey.fromWIF(senderMsgKeyRaw.privateKeyWIF)
  const recipientMsgPub = PublicKey.fromBuffer(
    Buffer.from(recipientMsgKeyRaw.publicKeyCompressedHex, 'hex'),
  )

  // --- Step 1: E2E encrypt the message using the REAL cashweb crypto.ts ---
  const pc = new PayloadConstructor({ networkName: 'livenet' })
  const sharedKey = pc.constructSharedKey(senderMsgPriv, recipientMsgPub, ECDH_SALT)
  const plaintextBytes = Buffer.from(message, 'utf8')
  const ciphertext = pc.encrypt(sharedKey, plaintextBytes)
  console.log('\n[1/4] Encrypted message with real cashweb ECDH+AES-CBC crypto.ts')
  console.log('  ciphertext (hex):', Buffer.from(ciphertext).toString('hex'))

  // --- Step 2: compute commitment hash h_m ---
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const senderPubKeyCompressed = senderMsgPriv.toPublicKey().toBuffer()
  const h_m = computeCommitment(message, senderPubKeyCompressed, timestampSeconds)
  console.log('\n[2/4] Computed commitment h_m =', h_m)
  console.log('  (over plaintext || senderPubKey || timestamp)')
  console.log('  timestamp:', timestampSeconds)

  // --- Step 3: send REAL Monad testnet tx ---
  const provider = new JsonRpcProvider(rpcUrl)
  const chainWallet = new ChainWallet(chainWalletRaw.privateKey, provider)

  const balance = await provider.getBalance(chainWallet.address)
  console.log('\n[3/4] Sending real Monad testnet tx')
  console.log('  from:', chainWallet.address, '(balance:', formatEther(balance), 'MON)')
  console.log('  to (burn address):', burnAddress)
  console.log('  value:', BURN_VALUE_MON, 'MON')
  console.log('  calldata (h_m):', h_m)

  if (balance === 0n) {
    console.error(
      '\nABORT: chain wallet has zero balance. Fund it with testnet MON first (see spike/check-balance.ts).',
    )
    process.exit(1)
  }

  const tx = await chainWallet.sendTransaction({
    to: burnAddress,
    value: BigInt(Math.round(Number(BURN_VALUE_MON) * 1e18)),
    data: h_m,
  })
  console.log('  tx submitted:', tx.hash)
  console.log('  waiting for confirmation...')
  const receipt = await tx.wait()
  console.log('  CONFIRMED in block', receipt?.blockNumber, 'status:', receipt?.status)

  // --- Step 4: persist encrypted payload + metadata for the receiver ---
  const payloadOut = {
    txHash: tx.hash,
    ciphertextHex: Buffer.from(ciphertext).toString('hex'),
    senderPubKeyCompressedHex: senderPubKeyCompressed.toString('hex'),
    recipientPubKeyCompressedHex: recipientMsgKeyRaw.publicKeyCompressedHex,
    timestampSeconds,
    ecdhSaltHex: ECDH_SALT.toString('hex'),
    h_m,
  }
  fs.writeFileSync(
    path.join(DATA_DIR, 'payload.json'),
    JSON.stringify(payloadOut, null, 2),
  )
  console.log('\n[4/4] Wrote out-of-band payload to spike/data/payload.json')

  console.log('\n=== DONE ===')
  console.log('tx hash:', tx.hash)
  console.log('verify with: npx tsx spike/receiver.ts', tx.hash)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

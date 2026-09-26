// THROWAWAY spike script — receiver/verifier side of the "Stamp" demo.
//
// 1. Fetches the REAL tx receipt from Monad testnet via Alchemy and extracts
//    h_m from calldata.
// 2. Loads the encrypted payload from spike/data/payload.json (stands in for
//    out-of-band delivery — no relay server in this spike).
// 3. Decrypts the message using the REAL app/src/cashweb/relay/crypto.ts
//    ECDH+AES-CBC code (PayloadConstructor), with the recipient's private key.
// 4. Independently recomputes h_m from the decrypted plaintext + sender
//    pubkey + timestamp, and checks it matches the on-chain calldata.
//
// Usage: npx tsx spike/receiver.ts <txHash>
import fs from 'node:fs'
import path from 'node:path'
import { JsonRpcProvider } from 'ethers'
import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'
import { PayloadConstructor } from '../app/src/cashweb/relay/crypto'
import { requireEnv, ENV_SOURCE } from './lib/env'
import { computeCommitment } from './lib/commitment'

const DATA_DIR = path.resolve(__dirname, 'data')

async function main() {
  const txHash = process.argv[2]
  if (!txHash) {
    console.error('Usage: npx tsx spike/receiver.ts <txHash>')
    process.exit(1)
  }

  console.log('env loaded from:', ENV_SOURCE)
  const rpcUrl = requireEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const burnAddress = requireEnv(
    'MONAD_STAMP_BURN_ADDRESS',
    '0x000000000000000000000000000000000000dEaD',
  )

  // --- Step 1: fetch the REAL receipt via Alchemy ---
  const provider = new JsonRpcProvider(rpcUrl)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) {
    console.error('No receipt found for', txHash, '(not mined yet, or wrong network?)')
    process.exit(1)
  }
  const tx = await provider.getTransaction(txHash)
  if (!tx) {
    console.error('No tx found for', txHash)
    process.exit(1)
  }

  console.log('\n[1/4] Fetched REAL on-chain receipt via Alchemy')
  console.log('  block:', receipt.blockNumber, 'status:', receipt.status)
  console.log('  to:', tx.to)
  console.log('  value:', tx.value.toString(), 'wei')

  if (tx.to?.toLowerCase() !== burnAddress.toLowerCase()) {
    console.warn('  WARNING: tx recipient does not match configured burn address!')
  }

  const h_m_onchain = tx.data
  console.log('  h_m (from calldata):', h_m_onchain)

  // --- Step 2: load out-of-band encrypted payload ---
  const payloadPath = path.join(DATA_DIR, 'payload.json')
  if (!fs.existsSync(payloadPath)) {
    console.error('No spike/data/payload.json found — run spike/sender.ts first.')
    process.exit(1)
  }
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
  console.log('\n[2/4] Loaded out-of-band encrypted payload from spike/data/payload.json')
  if (payload.txHash !== txHash) {
    console.warn(
      '  NOTE: payload.json was written for a different tx hash. Proceeding anyway (spike has no real pairing).',
    )
  }

  // --- Step 3: decrypt using REAL cashweb crypto.ts ---
  const recipientMsgKeyRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'recipient-messaging-key.json'), 'utf8'),
  )
  const recipientMsgPriv = PrivateKey.fromWIF(recipientMsgKeyRaw.privateKeyWIF)
  const senderMsgPub = PublicKey.fromBuffer(
    Buffer.from(payload.senderPubKeyCompressedHex, 'hex'),
  )

  const pc = new PayloadConstructor({ networkName: 'livenet' })
  const ecdhSalt = Buffer.from(payload.ecdhSaltHex, 'hex')
  const sharedKey = pc.constructSharedKey(recipientMsgPriv, senderMsgPub, ecdhSalt)
  const ciphertext = Buffer.from(payload.ciphertextHex, 'hex')
  const decrypted = pc.decrypt(sharedKey, ciphertext)
  const message = Buffer.from(decrypted).toString('utf8')

  console.log('\n[3/4] Decrypted message with REAL cashweb ECDH+AES-CBC crypto.ts')
  console.log('  message:', JSON.stringify(message))

  // --- Step 4: independently recompute h_m and compare ---
  const h_m_recomputed = computeCommitment(
    message,
    Buffer.from(payload.senderPubKeyCompressedHex, 'hex'),
    payload.timestampSeconds,
  )
  console.log('\n[4/4] Recomputed h_m independently from decrypted message + sender pubkey + timestamp')
  console.log('  h_m (recomputed):', h_m_recomputed)
  console.log('  h_m (on-chain)  :', h_m_onchain)

  const match = h_m_recomputed.toLowerCase() === h_m_onchain.toLowerCase()
  console.log('\n=== COMMITMENT', match ? 'VERIFIED ✓' : 'MISMATCH ✗', '===')
  if (!match) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

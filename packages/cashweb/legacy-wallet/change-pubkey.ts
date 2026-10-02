import { PrivateKey } from 'bitcore-lib-xpi'
import {
  cryptoBackend,
  lockingScript,
  privateKeyFromSecretBytes,
  publicFromPrivate,
  pubkeyHashFromBytes,
} from '@frank/nakamoto'

/** Public key bytes for a wallet change output (decision #580).
 * The secret must be 32 bytes in (0, n). Compressed is 33 bytes and
 * matches bitcore `toPublicKey().toBuffer()`. Uncompressed is 65 bytes,
 * `04 || x || y`. The caller's secret buffer is not wiped. Same point
 * encoding as registry identity keys (decision #578). Signing keys and
 * the relay change-address key stay on bitcore. */
export function walletChangePublicKey(
  secret: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const bytes = Uint8Array.from(secret)
  if (bytes.length !== 32) {
    bytes.fill(0)
    throw new Error('wallet-change-pubkey:secret')
  }
  if (compressed !== true && compressed !== false) {
    bytes.fill(0)
    throw new Error('wallet-change-pubkey:compressed')
  }
  const key = privateKeyFromSecretBytes(bytes, compressed)
  bytes.fill(0)
  if (!key.ok) throw new Error(`wallet-change-pubkey:${key.error.code}`)
  const derived = publicFromPrivate(key.value)
  key.value.bytes.fill(0)
  if (!derived.ok) {
    throw new Error(`wallet-change-pubkey:${derived.error.code}`)
  }
  const point = compressed
    ? derived.value.compressed
    : derived.value.uncompressed
  return Uint8Array.from(point)
}

/** 25-byte P2PKH change script. HASH160 of the change public key, then
 * the template from decision #495 (decision #580). */
export function walletChangeP2pkhScript(privKey: PrivateKey): Buffer {
  const compressed = (privKey as unknown as { compressed?: boolean }).compressed
  if (compressed !== true && compressed !== false) {
    throw new Error('wallet-change-pubkey:compressed')
  }
  const point = walletChangePublicKey(
    Uint8Array.from(privKey.toBuffer()),
    compressed,
  )
  const hash = pubkeyHashFromBytes(cryptoBackend.hash160(point))
  if (!hash.ok) throw new Error('p2pkh-hash')
  return Buffer.from(lockingScript({ kind: 'p2pkh', hash: hash.value }))
}

/** Private, deterministic identities for group boundary tests only. */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { directoryAddress } from '../relay/open-directory'
import {
  bytesToHex,
  hexToBytes,
  deriveIdentityMemberEpochTweak,
} from './group-crypto'
const order =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const GROUP_TEST_ACCOUNTS = [1, 2, 3, 4].map(value => {
  const privateKey = new Uint8Array(32).fill(value)
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  const publicKeyHex = bytesToHex(publicKey)
  const address = directoryAddress(publicKeyHex)!
  return {
    privateKey,
    publicKey,
    publicKeyHex,
    address,
    identityPubKeyHex: publicKeyHex,
  }
})
export function groupTestSigningKey(
  address: string,
  groupIdHex: string,
  epoch: number,
) {
  const account = GROUP_TEST_ACCOUNTS.find(
    candidate => candidate.address === address.toLowerCase(),
  )!
  const tweak = deriveIdentityMemberEpochTweak(
    account.publicKey,
    groupIdHex,
    epoch,
  )
  const scalar =
    (BigInt('0x' + bytesToHex(account.privateKey)) +
      BigInt('0x' + bytesToHex(tweak))) %
    order
  const privateKey = hexToBytes(scalar.toString(16).padStart(64, '0'))
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  return {
    privateKey,
    publicKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
  }
}
export function groupTestSigner(
  address: string,
  groupIdHex: string,
  epoch: number,
) {
  const key = groupTestSigningKey(address, groupIdHex, epoch)
  return {
    publicKey: key.publicKey,
    async signDigest(digest: Uint8Array) {
      return secp256k1
        .sign(digest, key.privateKey, { lowS: true })
        .toCompactRawBytes()
    },
  }
}

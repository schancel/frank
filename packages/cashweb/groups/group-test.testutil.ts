/** Private, deterministic identities for group boundary tests only. */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { directoryAddress } from '../relay/open-directory'
import { Transaction, Wallet, getBytes, hexlify } from 'ethers'
import {
  bytesToHex,
  hexToBytes,
  deriveIdentityMemberEpochTweak,
  type SealedGroupMessageEnvelope,
} from './group-crypto'
import type { GroupRelayClient } from './group-relay-client'
import {
  assertGroupWritePayment,
  groupWritePaymentPlan,
  type GroupWritePaymentWire,
  type GroupWritePolicy,
} from './group-write-payment'
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

/** Native chain ids of the networks these tests pay on (docs/protocol/chains/v1.json). */
const TEST_NATIVE_CHAIN_IDS: Record<string, bigint> = {
  'monad-testnet': 10143n,
}

/** A payment for `envelope` under `policy`, signed by a real key that holds no funds, at a
 * nonce derived from the write. The relays under test verify it from its bytes; nothing is
 * broadcast to any chain. */
export function groupTestPaymentFor(
  policy: GroupWritePolicy,
  groupIdHex: string,
  envelope: SealedGroupMessageEnvelope,
): GroupWritePaymentWire {
  const chainId = TEST_NATIVE_CHAIN_IDS[policy.network]
  if (chainId === undefined)
    throw new Error(`No test chain id for ${policy.network}`)
  const plan = groupWritePaymentPlan(policy, groupIdHex, envelope)
  // One payer key pays every test write, and a relay accepts one write per payer nonce, so
  // each write gets its own nonce, from its commitment (calldata after `GRPW || 0x01`).
  const nonce = plan.calldata
    .slice(5, 11)
    .reduce((value, byte) => value * 256 + byte, 0)
  const tx = Transaction.from({
    type: 2,
    chainId,
    nonce,
    to: plan.destination,
    value: plan.amountWei,
    data: hexlify(plan.calldata),
    gasLimit: 60_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
  tx.signature = new Wallet(`0x${'42'.repeat(32)}`).signingKey.sign(
    tx.unsignedHash,
  )
  return assertGroupWritePayment(plan, getBytes(tx.serialized))
}

/** The hosting relay's policy, read through `client` as the app reads it. */
export async function groupTestPayment(
  client: GroupRelayClient,
  groupIdHex: string,
  envelope: SealedGroupMessageEnvelope,
): Promise<GroupWritePaymentWire> {
  return groupTestPaymentFor(
    await client.getWritePolicy(groupIdHex),
    groupIdHex,
    envelope,
  )
}

/** Send `envelope` with its payment. The same envelope always carries the same signed bytes. */
export async function paidSend(
  client: GroupRelayClient,
  groupIdHex: string,
  envelope: SealedGroupMessageEnvelope,
) {
  return client.sendGroupMessage(
    groupIdHex,
    envelope,
    await groupTestPayment(client, groupIdHex, envelope),
  )
}

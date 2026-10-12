/** Pure recipient-only stealth destinations and public receipt validation. No coin credit or keys. */
import { Address } from "ecash-lib/dist/address/address";
import { Tx } from "ecash-lib/dist/tx";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import type { EcashAddressPrefix } from "./ecash-wallet";
import { getChainRegistryEntry } from "./chain/chains-registry";

export function assertEcashStealthChain(
  chainIdentifier: string,
  prefix: EcashAddressPrefix
): void {
  const chain = getChainRegistryEntry(chainIdentifier);
  if (
    chain?.id !== chainIdentifier ||
    chain.kind !== "ecash" ||
    chain.addressPrefix !== prefix
  )
    throw new Error("Invalid eCash stealth chain binding");
}

export interface EcashStealthDerivation {
  readonly chainIdentifier: string;
  readonly identityPublicKey: string;
  readonly ephemeralPubKey: string;
}

/** Backend custody only. Never exposed by a wallet handle or a session feature capability.
 * The pinned SDK signs BCH Schnorr from its own scalar keypairs, so its import boundary needs
 * this custody-internal callback rather than the app's secret-free signing capability.
 * The callback receives a temporary recipient-derived scalar, wiped after the SDK copies it.
 * Custody must bind derivation to its published Frank identity and validate its active session.
 */
export interface EcashStealthCustody {
  readonly identityPublicKey: string;
  assertActive(): void;
  withDerivedStealthSecret(
    derivation: EcashStealthDerivation,
    importIntoBackend: (temporarySecret: Uint8Array) => void
  ): Promise<void>;
}

export interface EcashStealthReceipt {
  readonly derivation: EcashStealthDerivation;
  readonly address: string;
  readonly publicKey: string;
  readonly claimedAmount: string;
  readonly payloadDigest: string;
  readonly timestamp: number;
  readonly transactions: ReadonlyArray<string>;
}

export function ecashStealthPoint(hex: string): Uint8Array {
  if (!/^(02|03)[0-9a-f]{64}$/.test(hex))
    throw new Error("Invalid compressed eCash stealth point");
  return secp256k1.ProjectivePoint.fromHex(hex).toRawBytes(true);
}

export function deriveEcashStealthDestination(params: {
  chainIdentifier: string;
  addressPrefix: EcashAddressPrefix;
  identityPublicKey: string;
  ephemeralSecret: Uint8Array;
}): EcashStealthDerivation & { address: string; publicKey: string } {
  assertEcashStealthChain(params.chainIdentifier, params.addressPrefix);
  const identity = ecashStealthPoint(params.identityPublicKey);
  const ephemeral = secp256k1.getPublicKey(params.ephemeralSecret, true);
  const shared = secp256k1.getSharedSecret(
    params.ephemeralSecret,
    identity,
    true
  );
  const digest = sha256(shared);
  try {
    // B + SHA256(eB)G; only the recipient knows b + SHA256(bE).
    const tweak =
      BigInt("0x" + Buffer.from(digest).toString("hex")) % secp256k1.CURVE.n;
    const point = secp256k1.ProjectivePoint.fromHex(identity);
    const key = (
      tweak === 0n
        ? point
        : point.add(secp256k1.ProjectivePoint.BASE.multiply(tweak))
    ).toRawBytes(true);
    return {
      chainIdentifier: params.chainIdentifier,
      identityPublicKey: params.identityPublicKey,
      ephemeralPubKey: Buffer.from(ephemeral).toString("hex"),
      address: Address.p2pkh(
        ripemd160(sha256(key)),
        params.addressPrefix
      ).toString(),
      publicKey: Buffer.from(key).toString("hex"),
    };
  } finally {
    shared.fill(0);
    digest.fill(0);
  }
}

/** Receipt claims are public assertions, never balances. The indexer establishes actual UTXOs.
 * Native transaction bytes have no network identifier; chain affinity is bound by composition.
 */
export function validateEcashStealthReceipt(
  receipt: EcashStealthReceipt,
  chainIdentifier: string,
  prefix: EcashAddressPrefix
): ReadonlyArray<string> {
  assertEcashStealthChain(chainIdentifier, prefix);
  if (
    receipt.derivation.chainIdentifier !== chainIdentifier ||
    !/^[0-9a-f]{64}$/.test(receipt.payloadDigest) ||
    !/^[1-9][0-9]*$/.test(receipt.claimedAmount) ||
    BigInt(receipt.claimedAmount) > 0xffffffffffffffffn ||
    !Number.isSafeInteger(receipt.timestamp) ||
    receipt.timestamp < 0 ||
    !Array.isArray(receipt.transactions) ||
    receipt.transactions.length === 0 ||
    receipt.transactions.length > 16
  )
    throw new Error("Invalid eCash stealth receipt");
  ecashStealthPoint(receipt.derivation.identityPublicKey);
  ecashStealthPoint(receipt.derivation.ephemeralPubKey);
  const expected = Address.p2pkh(
    ripemd160(sha256(ecashStealthPoint(receipt.publicKey))),
    prefix
  );
  if (expected.toString() !== receipt.address)
    throw new Error("eCash stealth receipt address mismatch");
  const script = expected.toScript().toHex();
  const hashes = new Set<string>();
  const outpoints: string[] = [];
  let amount = 0n;
  for (const raw of receipt.transactions) {
    if (
      typeof raw !== "string" ||
      raw.length > 32768 ||
      !/^(?:[0-9a-f]{2})+$/.test(raw)
    )
      throw new Error("Invalid eCash stealth transaction bytes");
    const tx = Tx.fromHex(raw);
    if (
      Buffer.from(tx.ser()).toString("hex") !== raw ||
      tx.inputs.length === 0 ||
      tx.inputs.some((input) => (input.script?.bytecode.length ?? 0) === 0)
    )
      throw new Error("Expected a complete signed eCash transaction");
    const hash = Buffer.from(sha256(sha256(tx.ser())))
      .reverse()
      .toString("hex");
    if (hashes.has(hash))
      throw new Error("Duplicate eCash stealth transaction");
    hashes.add(hash);
    tx.outputs.forEach((output, vout) => {
      if (output.script.toHex() === script && output.sats > 0n) {
        amount += output.sats;
        outpoints.push(`${hash}:${vout}`);
      }
    });
  }
  if (amount !== BigInt(receipt.claimedAmount))
    throw new Error("eCash stealth transaction amount mismatch");
  return outpoints;
}

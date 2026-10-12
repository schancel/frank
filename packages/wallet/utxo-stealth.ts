/** Recipient-only secp256k1 stealth destinations for the configured Bitcoin-family scripts.
 * No storage, network or recipient private scalar is present in this module. */
import {
  cryptoBackend,
  encodeAddress,
  lockingScript,
  pubkeyHashFromBytes,
} from "@frank/nakamoto";
import type { SigningKey } from "@frank/nakamoto";
import { stealthEphemeralPublicKey } from "@frank/cashweb/relay/stealth-ephemeral-pubkey";
import { stealthSharedPoint } from "@frank/cashweb/relay/stealth-shared";
import { stealthPointDigest } from "@frank/cashweb/relay/stealth-point-digest";
import { stealthParentPublicKey } from "@frank/cashweb/relay/stealth-public";
import type { UtxoNetwork } from "./utxo-wallet";

/** Public facts sufficient for the recipient's custody to re-derive one signing capability.
 * identityPublicKey is the published Frank identity, independent of the UTXO HD domain root. */
export interface UtxoStealthDerivation {
  readonly chainIdentifier: string;
  readonly identityPublicKey: Uint8Array;
  readonly ephemeralPubKey: Uint8Array;
}

/** Composition supplies custody, which validates chain/identity, derives and wipes temporary
 * scalars internally, and invalidates signing capabilities when the captured session closes. */
export interface UtxoStealthCustody {
  readonly identityPublicKey: Uint8Array;
  deriveStealthSigner(derivation: UtxoStealthDerivation): Promise<SigningKey>;
}

export interface UtxoStealthDestination {
  readonly derivation: UtxoStealthDerivation;
  readonly publicKey: Uint8Array;
  readonly address: string;
  readonly scriptPubKey: Uint8Array;
}

export function requireCompressedStealthPoint(point: Uint8Array): Uint8Array {
  if (point.length !== 33)
    throw new Error("Expected a compressed stealth public key");
  // A zero tweak validates and canonically re-encodes the same point, including infinity checks.
  return stealthParentPublicKey(Uint8Array.from(point), new Uint8Array(32));
}

export function utxoStealthDestination(
  network: UtxoNetwork,
  publicKey: Uint8Array
): Pick<UtxoStealthDestination, "publicKey" | "address" | "scriptPubKey"> {
  const point = requireCompressedStealthPoint(publicKey);
  const hash = pubkeyHashFromBytes(cryptoBackend.hash160(point));
  if (!hash.ok) throw new Error("Invalid stealth public key hash");
  const destination = { kind: network.ownOutput, hash: hash.value };
  const encoded = encodeAddress(
    destination,
    network.descriptor,
    network.addressEncoding
  );
  if (!encoded.ok) throw new Error("Invalid stealth destination address");
  return {
    publicKey: point,
    address: encoded.value,
    scriptPubKey: lockingScript(destination),
  };
}

/** The caller generates a fresh scalar for a newly authorized payment and retains the returned
 * descriptor/transaction on retry. Sender knows e and the tweak, but never recipient scalar b. */
export function deriveUtxoStealthDestination(params: {
  network: UtxoNetwork;
  identityPublicKey: Uint8Array;
  ephemeralSecret: Uint8Array;
}): UtxoStealthDestination {
  const identityPublicKey = requireCompressedStealthPoint(
    params.identityPublicKey
  );
  const ephemeralPubKey = stealthEphemeralPublicKey(
    params.ephemeralSecret,
    true
  );
  const digest = stealthPointDigest(
    stealthSharedPoint(params.ephemeralSecret, identityPublicKey)
  );
  return {
    derivation: {
      chainIdentifier: params.network.chainIdentifier,
      identityPublicKey,
      ephemeralPubKey,
    },
    ...utxoStealthDestination(
      params.network,
      stealthParentPublicKey(identityPublicKey, digest)
    ),
  };
}

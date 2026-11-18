/**
 * Custody-internal derivation of per-swap eCash HTLC keys. Never exported through a wallet
 * handle; `EcashWallet.htlcPublicKey` / `signHtlcSpend` are the only consumers.
 *
 * EXPLICIT NEW DERIVATION (AGENTS.md §6), `frank/xec-htlc-key/v1`:
 *
 *   account = BIP32(seed) at m/44'/1899'/0'   (the eCash SDK account the wallet already uses)
 *   root    = HKDF-Extract(SHA-256, salt = utf8("frank/xec-htlc-key/v1"), ikm = account secret key)
 *   key     = HKDF-Expand(SHA-256, root, info, 32)
 *   info    = u8(len(chainIdentifier)) ‖ utf8(chainIdentifier) ‖ swapId (32 bytes) ‖ utf8(role)
 *
 * `role` is "claim" (party B's key) or "refund" (party A's key); it is the last field, so the
 * length prefix on the chain identifier makes the encoding unambiguous. An expanded value that
 * is not a valid secp256k1 scalar (probability ~2^-128) is refused rather than adjusted.
 * Keys depend only on the seed, chain, swap and role, so every device of the account derives
 * the same keys and, with RFC 6979 signatures, the same spend txids. The pinned vector lives in
 * ecash-htlc.jest.test.ts; changing any of the above is a new derivation version.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { extract, expand } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { XecHtlcBranch } from "./ecash-htlc";

export const XEC_HTLC_KEY_LABEL = "frank/xec-htlc-key/v1";

/** HKDF-Extract of the account secret key; the caller owns (and may wipe) both buffers. */
export function xecHtlcKeyRoot(accountSecretKey: Uint8Array): Uint8Array {
  if (
    !(accountSecretKey instanceof Uint8Array) ||
    accountSecretKey.length !== 32
  )
    throw new Error("Expected the 32-byte eCash account secret key");
  return extract(
    sha256,
    accountSecretKey,
    new TextEncoder().encode(XEC_HTLC_KEY_LABEL)
  );
}

export function xecHtlcKeyInfo(
  chainIdentifier: string,
  swapId: string,
  role: XecHtlcBranch
): Uint8Array {
  const chain = new TextEncoder().encode(chainIdentifier);
  if (chain.length === 0 || chain.length > 255)
    throw new Error("Invalid chain identifier for an eCash HTLC key");
  if (!/^[0-9a-f]{64}$/.test(swapId))
    throw new Error("Swap id must be 32 bytes of lowercase hex");
  if (role !== "claim" && role !== "refund")
    throw new Error("eCash HTLC key role must be claim or refund");
  return Uint8Array.from([
    chain.length,
    ...chain,
    ...Buffer.from(swapId, "hex"),
    ...new TextEncoder().encode(role),
  ]);
}

/** A fresh 32-byte secret key; the caller wipes it after use. */
export function deriveXecHtlcSecretKey(
  root: Uint8Array,
  chainIdentifier: string,
  swapId: string,
  role: XecHtlcBranch
): Uint8Array {
  if (!(root instanceof Uint8Array) || root.length !== 32)
    throw new Error("Expected the 32-byte eCash HTLC key root");
  const key = expand(
    sha256,
    root,
    xecHtlcKeyInfo(chainIdentifier, swapId, role),
    32
  );
  if (!secp256k1.utils.isValidPrivateKey(key)) {
    key.fill(0);
    throw new Error("eCash HTLC key derivation produced an invalid scalar");
  }
  return key;
}

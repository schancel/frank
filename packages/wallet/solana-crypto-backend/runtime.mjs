// Experimental host adapter; deliberately absent from wallet/app exports.
import init, { RecipientCustody } from "./generated/backend.js";

let initialized;
async function ready(wasm) {
  initialized ??= init({ module_or_path: wasm }).catch((error) => {
    initialized = undefined;
    throw error;
  });
  await initialized;
}

// Ingest the existing derived Solana seed once. Wipe the caller-owned transfer buffer on
// success AND failure. Never retain a JS seed, scalar, keypair or fallback implementation.
export async function openExperimentalRecipientCustody({
  accountId,
  chainIdentifier,
  seed,
  wasm,
  signal,
}) {
  // Capture the one-shot handoff synchronously before WASM initialization can yield.
  const ownedSeed = new Uint8Array(seed);
  const ownedAccountId = new Uint8Array(accountId);
  seed.fill(0);
  try {
    if (signal?.aborted) throw new Error("solana-custody:Revoked");
    await ready(wasm);
    if (signal?.aborted) throw new Error("solana-custody:Revoked");
    const handle = new RecipientCustody(
      ownedAccountId,
      chainIdentifier,
      ownedSeed
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      handle.close();
      handle.free();
    };
    signal?.addEventListener("abort", close, { once: true });
    return Object.freeze({
      primaryPublicKey() {
        if (closed) throw new Error("solana-custody:Revoked");
        return Uint8Array.from(handle.primaryPublicKey());
      },
      deriveDestination(intent) {
        if (closed) throw new Error("solana-custody:Revoked");
        return JSON.parse(handle.deriveDestination(JSON.stringify(intent)));
      },
      signReceivedTransfer(received, descriptor, spend, authorization) {
        if (closed) throw new Error("solana-custody:Revoked");
        const result = JSON.parse(
          handle.signReceivedTransfer(
            JSON.stringify(received),
            JSON.stringify(descriptor),
            JSON.stringify(spend),
            JSON.stringify(authorization)
          )
        );
        return Object.freeze({
          accountId: Uint8Array.from(result.accountId),
          publicKey: Uint8Array.from(result.publicKey),
          signature: Uint8Array.from(result.signature),
          message: Uint8Array.from(result.message),
        });
      },
      validateReceivedDescriptor(received) {
        if (closed) throw new Error("solana-custody:Revoked");
        return Uint8Array.from(
          handle.validateReceivedDescriptor(JSON.stringify(received))
        );
      },
      signPrimaryTransfer(descriptor, spend, authorization) {
        if (closed) throw new Error("solana-custody:Revoked");
        const result = JSON.parse(
          handle.signPrimaryTransfer(
            JSON.stringify(descriptor),
            JSON.stringify(spend),
            JSON.stringify(authorization)
          )
        );
        return Object.freeze({
          accountId: Uint8Array.from(result.accountId),
          publicKey: Uint8Array.from(result.publicKey),
          signature: Uint8Array.from(result.signature),
          message: Uint8Array.from(result.message),
        });
      },
      close,
    });
  } finally {
    ownedSeed.fill(0);
  }
}

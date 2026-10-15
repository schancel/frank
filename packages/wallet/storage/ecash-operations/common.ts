import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import registry from "../../../../docs/protocol/chains/v1.json";
import { nativeTransactionAttemptKey } from "../../chain/chain-wallet";
import {
  parseEcashOperationLedger,
  type EcashOperationLedger,
  type EcashOperationStore,
} from "../../ecash-operation-store";

export interface EcashStoreBinding {
  /** Already validated by the host wallet, without aliases. */
  readonly chainIdentifier: string;
  readonly walletAddress: string;
}

export interface OwnedEcashOperationStore extends EcashOperationStore {
  readonly walletKey: string;
  readonly namespace: string;
  close(): Promise<void>;
}

export const LEDGER_KEY = "ledger-v1";
export const OBJECT_STORE = "ledger";

export function bind(input: EcashStoreBinding) {
  const { chainIdentifier, walletAddress } = input;
  if (
    !registry.chains.some(
      (chain) => chain.id === chainIdentifier && chain.family === "bitcoin"
    )
  )
    throw new Error("Expected a canonical Bitcoin-family chain identifier");
  if (!/^[\x21-\x7e]{1,256}$/.test(walletAddress))
    throw new Error("Expected a host-validated canonical wallet address");
  const walletKey = nativeTransactionAttemptKey({
    family: "bitcoin",
    chainIdentifier,
    address: walletAddress,
  });
  return Object.freeze({ chainIdentifier, walletAddress, walletKey });
}

export function namespaceFor(
  binding: ReturnType<typeof bind>,
  discriminator?: string
): string {
  if (
    discriminator !== undefined &&
    !/^[A-Za-z0-9._-]{1,64}$/.test(discriminator)
  )
    throw new Error("Invalid browser storage namespace discriminator");
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(binding.walletKey))
  );
  return `frank-ecash-operations-v1-${
    discriminator === undefined ? "" : discriminator + "-"
  }${digest}`;
}

export function requireKey(
  binding: ReturnType<typeof bind>,
  key: string
): void {
  if (key !== binding.walletKey)
    throw new Error("eCash store key affinity mismatch");
}

export function parseBound(
  binding: ReturnType<typeof bind>,
  bytes: string
): EcashOperationLedger {
  const ledger = parseEcashOperationLedger(bytes);
  if (
    ledger.chainIdentifier !== binding.chainIdentifier ||
    ledger.walletAddress !== binding.walletAddress
  )
    throw new Error("eCash ledger affinity mismatch");
  return ledger;
}

/** One owner queue, not a substitute for the wallet's canonical cross-context selection lock. */
export class StoreQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private closing?: Promise<void>;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("eCash store is closed"));
    if (this.poisoned)
      return Promise.reject(
        new Error("eCash store is poisoned; close and reopen")
      );
    const result = this.tail.then(async () => {
      if (this.poisoned)
        throw new Error("eCash store is poisoned; close and reopen");
      try {
        return await work();
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  close(release: () => Promise<void>): Promise<void> {
    this.closed = true;
    return (this.closing ??= this.tail.then(release));
  }
}

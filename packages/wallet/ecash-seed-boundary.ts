import { DERIVATION_REGISTRY_ID, registryEntry } from "../domain-roots/src";
import type { DomainRoot } from "../domain-roots/src";
import type { ChronikClient } from "chronik-client";
import type { HdNode } from "ecash-lib/dist/hdwallet";
import type {
  EcashAddressPrefix,
  EcashWalletBackend,
  EcashWalletFactory,
} from "./ecash-wallet";

/** Validate the frozen registry interpretation, then copy before asynchronous effects. */
export function snapshotEcashDomainRoot(
  root: DomainRoot<"ecash-bch-wallet">
): DomainRoot<"ecash-bch-wallet"> {
  if (
    root === null ||
    typeof root !== "object" ||
    root.registry !== DERIVATION_REGISTRY_ID ||
    root.purpose !== "ecash-bch-wallet" ||
    !(root.bytes instanceof Uint8Array) ||
    root.bytes.length !== registryEntry("ecash-bch-wallet").outputLength
  ) {
    throw new Error(
      "Expected a frank-domain-roots-v1 ecash-bch-wallet root of exactly 32 bytes"
    );
  }
  return {
    registry: DERIVATION_REGISTRY_ID,
    purpose: "ecash-bch-wallet",
    bytes: Uint8Array.from(root.bytes),
  };
}

// ecash-wallet 6.2.1 publishes no declarations. This is its existing runtime HD constructor,
// pinned by the actual-SDK test. Keep this assertion here; never expose SDK internals to callers.
interface EcashSdkHdConstructor {
  new (
    sk: Uint8Array,
    chronik: ChronikClient,
    baseHdNode: HdNode,
    accountNumber: number,
    prefix: EcashAddressPrefix
  ): EcashWalletBackend;
}

export const createEcashSeedBackend: EcashWalletFactory = async ({
  domainRoot,
  chronik,
  addressPrefix,
}) => {
  const root = snapshotEcashDomainRoot(domainRoot);
  try {
    const imported = await import("ecash-wallet/dist/index.js");
    const { HdNode } = await import("ecash-lib");
    const sdk = imported as unknown as {
      Wallet?: unknown;
      default?: { Wallet?: unknown };
    };
    const Wallet = sdk.Wallet ?? sdk.default?.Wallet;
    if (typeof Wallet !== "function")
      throw new Error("ecash-wallet did not export Wallet");
    // Same account and path as the pinned SDK's HD constructor, with the registry bytes fed
    // directly to BIP32. No mnemonic encoding or PBKDF2 is part of this interpretation.
    const account = HdNode.fromSeed(root.bytes).derivePath("m/44'/1899'/0'");
    const secretKey = account.seckey();
    if (secretKey === undefined)
      throw new Error("eCash seed did not produce a private HD account");
    return new (Wallet as EcashSdkHdConstructor)(
      secretKey,
      chronik,
      account,
      0,
      addressPrefix
    );
  } finally {
    root.bytes.fill(0);
  }
};

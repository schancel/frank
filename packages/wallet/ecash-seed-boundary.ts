import {
  BIP39_DERIVATION,
  DERIVATION_REGISTRY_ID,
  registryEntry,
} from "../domain-roots/src";
import type { DomainRoot, HistoricalBip39Seed } from "../domain-roots/src";
import type { ChronikClient } from "chronik-client";
import type { HdNode } from "ecash-lib/dist/hdwallet";
import type { EcashSdkBackend, EcashSdkWallet } from "./ecash-sdk-backend";
import type {
  EcashAddressPrefix,
  EcashWalletFactory,
  EcashBip39WalletFactory,
} from "./ecash-wallet";
import type { EcashStealthCustody } from "./ecash-stealth";

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
  ): EcashSdkWallet;
}

/** Host custody composition; the returned factory passes no key capability through a wallet. */
export function createEcashStealthSeedBackend(custody: EcashStealthCustody) {
  return seedBackendFactory(custody);
}

/** Historical custody keeps the original raw 64-byte seed. It never treats it as a v1 root. */
export function createEcashStealthBip39SeedBackend(
  custody: EcashStealthCustody
): EcashBip39WalletFactory {
  return ({ material, chronik, addressPrefix }) =>
    createEcashBip39SeedBackend(material, chronik, addressPrefix, custody);
}

export const createEcashSeedBackend = seedBackendFactory();

function seedBackendFactory(custody?: EcashStealthCustody) {
  return async ({
    domainRoot,
    chronik,
    addressPrefix,
  }: Parameters<EcashWalletFactory>[0]): Promise<EcashSdkBackend> => {
    const root = snapshotEcashDomainRoot(domainRoot);
    try {
      return await createBackend(root.bytes, chronik, addressPrefix, custody);
    } finally {
      root.bytes.fill(0);
    }
  };
}

export async function createEcashBip39SeedBackend(
  material: HistoricalBip39Seed,
  chronik: ChronikClient,
  addressPrefix: EcashAddressPrefix,
  custody?: EcashStealthCustody
): Promise<EcashSdkBackend> {
  if (
    material.derivation !== BIP39_DERIVATION ||
    !(material.seed instanceof Uint8Array) ||
    material.seed.length !== 64
  )
    throw new Error("Expected the original 64-byte historical BIP39 seed");
  const seed = new Uint8Array(material.seed);
  try {
    return await createBackend(seed, chronik, addressPrefix, custody);
  } finally {
    seed.fill(0);
  }
}

async function createBackend(
  seed: Uint8Array,
  chronik: ChronikClient,
  addressPrefix: EcashAddressPrefix,
  custody?: EcashStealthCustody
): Promise<EcashSdkBackend> {
  const imported = await import("ecash-wallet/dist/index.js");
  const { HdNode } = await import("ecash-lib");
  const { EcashSdkBackend } = await import("./ecash-sdk-backend");
  const sdk = imported as unknown as {
    Wallet?: unknown;
    default?: { Wallet?: unknown };
  };
  const Wallet = sdk.Wallet ?? sdk.default?.Wallet;
  if (typeof Wallet !== "function")
    throw new Error("ecash-wallet did not export Wallet");
  // Both supported custody representations enter the established SDK BIP32 account path.
  const account = HdNode.fromSeed(seed).derivePath("m/44'/1899'/0'");
  const secretKey = account.seckey();
  if (secretKey === undefined)
    throw new Error("eCash seed did not produce a private HD account");
  return new EcashSdkBackend(
    new (Wallet as EcashSdkHdConstructor)(
      secretKey,
      chronik,
      account,
      0,
      addressPrefix
    ),
    chronik,
    addressPrefix,
    custody
  );
}

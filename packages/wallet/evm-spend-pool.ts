import { Wallet, getBytes, hexlify, randomBytes } from "ethers";
import type { MonadIdentity } from "./evm-identity";
import type { EvmHdKeyring, EvmChangeKeyring } from "./secp256k1-hd-keyring";
import type { EvmSubAccountPool } from "./evm-account-pool";
import type { EvmChangePool } from "./evm-change-pool";
import { deriveEvmStealthPrivateKey } from "./evm-stealth";
import {
  fundedErc20Coins,
  spendableCoins,
  type EvmCoin,
  type RecordStore,
} from "./storage/evm-coin-store";
import type {
  EvmNativeOperationJournal,
  EvmNativeSource,
} from "./storage/evm-native-operation-journal";

export interface EvmSpendPoolFundingCandidate {
  readonly source: "main" | "identity" | "coin";
  readonly address: string;
  readonly privateKey: () => string;
  readonly balanceWei?: bigint;
}

export type EvmSpendPoolJournalSource =
  | Pick<EvmNativeOperationJournal, "sourceReferences">
  | (() => Pick<EvmNativeOperationJournal, "sourceReferences"> | undefined);

export interface EvmSpendPoolParams {
  readonly mainAccount: Wallet;
  readonly identity: MonadIdentity;
  readonly keyring: EvmHdKeyring;
  readonly changeKeyring: EvmChangeKeyring;
  readonly pool: EvmSubAccountPool;
  readonly changePool: EvmChangePool;
  readonly coinStore: RecordStore<EvmCoin>;
  readonly nativeJournal: EvmSpendPoolJournalSource;
  readonly holdsSource?: (address: string) => boolean;
  readonly knownChangeSources?: () => readonly { index: number; address: string }[];
}

/**
 * Per-wallet spend pool for an EVM chain wallet.
 *
 * Unifies all spendable entries managed by a single wallet instance across its key origins
 * (`kind: 'main' | 'identity' | 'spend' | 'change' | 'identity-stealth-v1' | 'coin'`) while
 * delegating persistence to the existing durable LevelDB stores (`sub-account-pool`,
 * `change-pool`, `coins`, and `evm-native-operation-journal`) without altering on-disk schemas.
 */
export class EvmSpendPool {
  readonly mainAccount: Wallet;
  readonly identity: MonadIdentity;
  readonly identityPublicKey: string;
  readonly keyring: EvmHdKeyring;
  readonly changeKeyring: EvmChangeKeyring;
  readonly pool: EvmSubAccountPool;
  readonly changePool: EvmChangePool;
  readonly coinStore: RecordStore<EvmCoin>;
  readonly nativeJournal: EvmSpendPoolJournalSource;
  private readonly knownChangeSources?: EvmSpendPoolParams["knownChangeSources"];
  private readonly defaultHoldsSource?: (address: string) => boolean;

  constructor(params: EvmSpendPoolParams) {
    this.mainAccount = params.mainAccount;
    this.identity = params.identity;
    this.identityPublicKey = hexlify(
      params.identity.compressedPubKey
    ).toLowerCase();
    this.keyring = params.keyring;
    this.changeKeyring = params.changeKeyring;
    this.pool = params.pool;
    this.changePool = params.changePool;
    this.coinStore = params.coinStore;
    this.nativeJournal = params.nativeJournal;
    this.defaultHoldsSource = params.holdsSource;
    this.knownChangeSources = params.knownChangeSources;
  }

  /**
   * Derives or resolves the signing wallet for a spend pool entry from its `kind` discriminator
   * and verifies that the derived signer matches the entry's address.
   */
  resolveSource(source: EvmNativeSource): Wallet {
    let signer: Wallet;
    if (source.kind === "main") {
      signer = this.mainAccount;
    } else if (source.kind === "spend") {
      signer = new Wallet(
        this.keyring.deriveSubAccount(source.index).privateKey
      );
    } else if (source.kind === "change") {
      signer = new Wallet(
        this.changeKeyring.deriveChangeAccount(source.index).privateKey
      );
    } else if (source.kind === "coin") {
      const coin = this.coinStore.get(source.address);
      if (coin === undefined) {
        throw new Error("Native source is not a coin of this wallet");
      }
      signer = new Wallet(coin.privateKey);
    } else {
      if (source.identityPublicKey !== this.identityPublicKey) {
        throw new Error("Native source belongs to another identity");
      }
      signer = new Wallet(
        source.kind === "identity"
          ? this.identity.toPrivateKeyHex()
          : deriveEvmStealthPrivateKey({
              recipientSpendSecret: this.identity.toPrivateKeyHex(),
              ephemeralPubKey: getBytes(source.ephemeralPublicKey),
            }).stealthPrivateKey
      );
    }
    if (signer.address.toLowerCase() !== source.address.toLowerCase()) {
      throw new Error("Native custody source address mismatch");
    }
    return signer;
  }

  /**
   * Maps a received `EvmCoin` record to its typed spend-pool source reference.
   */
  coinSource(coin: EvmCoin): EvmNativeSource {
    return coin.origin === "stealth" && coin.ephemeralPubKey !== undefined
      ? {
          kind: "identity-stealth-v1",
          address: coin.address,
          identityPublicKey: this.identityPublicKey,
          ephemeralPublicKey: `0x${coin.ephemeralPubKey}`,
        }
      : { kind: "coin", address: coin.address };
  }

  /**
   * Returns all spendable source entries in this wallet across `main`, `identity`, `spend`,
   * `change`, `identity-stealth-v1`, `coin`, and retained journal references, verifying
   * provenance for each entry before returning.
   */
  async getSources(): Promise<EvmNativeSource[]> {
    if (this.pool.records().some((record) => record.status === "funding")) {
      throw new Error(
        "Native send is unavailable while pool funding remains pending"
      );
    }
    const changeRecords = this.changePool.records();
    const recoveredChange = this.changePool.recoveredAccounts();
    const knownChange = this.knownChangeSources?.() ?? [];
    const recordedChangeIndices = new Set([
      ...knownChange.map((r) => r.index),
      ...changeRecords.map((r) => r.index),
      ...recoveredChange.map((r) => r.index),
    ]);
    const refs: EvmNativeSource[] = [
      { kind: "main", address: this.mainAccount.address.toLowerCase() },
      {
        kind: "identity",
        address: this.identity.address.raw.toLowerCase(),
        identityPublicKey: this.identityPublicKey,
      },
      ...this.pool
        .records()
        .filter(
          (r) =>
            r.status !== "in-use" &&
            r.status !== "funding" &&
            this.pool.claimedBy(r.index) === undefined
        )
        .map((r) => ({
          kind: "spend" as const,
          address: r.address.toLowerCase(),
          index: r.index,
        })),
      ...knownChange.map((r) => ({
        kind: "change" as const, address: r.address.toLowerCase(), index: r.index,
      })),
      ...changeRecords.map((r) => ({
        kind: "change" as const,
        address: r.address.toLowerCase(),
        index: r.index,
      })),
      ...recoveredChange.map((r) => ({
        kind: "change" as const,
        address: r.address.toLowerCase(),
        index: r.index,
      })),
      ...[0, 1, 2, 3, 4]
        .filter((index) => !recordedChangeIndices.has(index))
        .map((index) => ({
          kind: "change" as const,
          address: this.changeKeyring
            .deriveChangeAccount(index)
            .address.toLowerCase(),
          index,
        })),
      ...this.coinStore
        .all()
        .filter(
          (coin) =>
            spendableCoins([coin]).length > 0 ||
            (coin.erc20Positions ?? []).some(
              (position) =>
                fundedErc20Coins([coin], position.contractAddress).length > 0
            )
        )
        .map((coin) => this.coinSource(coin)),
      ...((typeof this.nativeJournal === "function"
        ? this.nativeJournal()
        : this.nativeJournal
      )?.sourceReferences() ?? []),
    ];
    for (const ref of refs) {
      this.resolveSource(ref);
    }
    const unique = new Map<string, EvmNativeSource>();
    for (const ref of refs) {
      const address = ref.address.toLowerCase();
      if (!unique.has(address)) unique.set(address, ref);
    }
    return [...unique.values()];
  }

  /**
   * Returns whether a spend pool entry is currently claimed by another operation.
   */
  sourceHeld(source: EvmNativeSource, mainAccountHolder: string): boolean {
    if (source.kind === "spend") {
      const record = this.pool.getRecord(source.index);
      return (
        this.pool.claimedBy(source.index) !== undefined ||
        record?.status === "in-use" ||
        record?.status === "funding" ||
        ((record?.status === "spent" || record?.status === "retired") &&
          !record.lifecycle?.spend)
      );
    }
    const claimant = this.pool.accountClaimedBy(source.address);
    return claimant !== undefined && claimant !== mainAccountHolder;
  }

  /**
   * Atomically claims a set of spend pool entries (`spend` indices and non-spend account
   * addresses) for a native operation and returns a release callback.
   */
  claimSources(
    sources: readonly EvmNativeSource[],
    mainAccountHolder: string
  ): () => void {
    const indices = sources.flatMap((source) =>
      source.kind === "spend" ? [source.index] : []
    );
    const held = indices.find((index) => {
      const record = this.pool.getRecord(index);
      return (
        this.pool.claimedBy(index) !== undefined ||
        record?.status === "in-use" ||
        record?.status === "funding" ||
        ((record?.status === "spent" || record?.status === "retired") &&
          !record.lifecycle?.spend)
      );
    });
    if (held !== undefined) {
      throw new RangeError(
        `Sub-account ${held} is held by another operation; plan the send again`
      );
    }
    const holder = `${this.identity.address.raw.toLowerCase()}:native:${hexlify(
      randomBytes(8)
    )}`;
    const addresses = sources.flatMap((source) =>
      source.kind === "spend" ||
      this.pool.accountClaimedBy(source.address) === mainAccountHolder
        ? []
        : [source.address]
    );
    const taken = addresses.find(
      (address) => this.pool.accountClaimedBy(address) !== undefined
    );
    if (taken !== undefined) {
      throw new RangeError(
        `${taken} is held by another operation; plan the send again`
      );
    }
    this.pool.restoreClaim(holder, indices);
    for (const address of addresses) {
      this.pool.restoreAccountClaim(holder, address);
    }
    return () => this.pool.releaseClaim(holder);
  }

  /**
   * Returns ordered funding candidates (`main`, `identity`, and unheld spendable `coin`s)
   * for stamp inventory and topic burn preparation.
   */
  fundingCandidates(
    holdsNativeSource?: (address: string) => boolean
  ): readonly EvmSpendPoolFundingCandidate[] {
    const holds = holdsNativeSource ?? this.defaultHoldsSource ?? (() => false);
    return [
      {
        source: "main" as const,
        address: this.mainAccount.address,
        privateKey: () => this.mainAccount.privateKey,
      },
      ...(this.identity.address.raw.toLowerCase() ===
      this.mainAccount.address.toLowerCase()
        ? []
        : [
            {
              source: "identity" as const,
              address: this.identity.address.raw,
              privateKey: () => this.identity.toPrivateKeyHex(),
            },
          ]),
      ...spendableCoins(this.coinStore.all())
        .filter((coin) => !holds(coin.address))
        .sort((a, b) =>
          BigInt(a.amountWei) > BigInt(b.amountWei) ? -1 : 1
        )
        .map((coin) => ({
          source: "coin" as const,
          address: coin.address,
          privateKey: () => coin.privateKey,
          balanceWei: BigInt(coin.amountWei),
        })),
    ];
  }
}

import { Wallet, getBytes, hexlify, randomBytes } from "ethers";
import type { MonadIdentity } from "./evm-identity";
import type { EvmHdKeyring, EvmChangeKeyring } from "./secp256k1-hd-keyring";
import type { EvmSubAccountPool } from "./evm-account-pool";
import { deriveEvmStealthPrivateKey } from "./evm-stealth";
import type { EvmCoin, RecordStore } from "./storage/evm-coin-store";
import type { EvmNativeSource } from "./storage/evm-native-operation-journal";

export interface EvmNativeSourcesParams {
  readonly mainAccount: Wallet;
  readonly identity: MonadIdentity;
  readonly keyring: EvmHdKeyring;
  readonly changeKeyring: EvmChangeKeyring;
  readonly pool: EvmSubAccountPool;
  readonly coinStore: RecordStore<EvmCoin>;
  readonly isAccountReserved?: (address: string) => boolean;
}

/**
 * Custody of the source references a native-journal operation (a contract call, a token
 * payment) records: the signer for each (`resolveSource`, checked against its address) and
 * the claim that keeps two operations off one account. It selects nothing and holds no money:
 * what the wallet can spend is its one coin list (`EvmCoinList`), and every native payment is
 * built from that list by `EvmTransactionSetPreparer`.
 */
export class EvmNativeSources {
  readonly mainAccount: Wallet;
  readonly identity: MonadIdentity;
  readonly identityPublicKey: string;
  readonly keyring: EvmHdKeyring;
  readonly changeKeyring: EvmChangeKeyring;
  readonly pool: EvmSubAccountPool;
  readonly coinStore: RecordStore<EvmCoin>;
  private readonly isAccountReserved: (address: string) => boolean;

  constructor(params: EvmNativeSourcesParams) {
    this.mainAccount = params.mainAccount;
    this.identity = params.identity;
    this.identityPublicKey = hexlify(
      params.identity.compressedPubKey
    ).toLowerCase();
    this.keyring = params.keyring;
    this.changeKeyring = params.changeKeyring;
    this.pool = params.pool;
    this.coinStore = params.coinStore;
    this.isAccountReserved = params.isAccountReserved ?? (() => false);
  }

  /**
   * Derives or resolves the signing wallet for a source from its `kind` discriminator
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
   * Maps a received `EvmCoin` record to its typed native source reference.
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
   * Returns whether a source is currently claimed by another operation.
   */
  sourceHeld(source: EvmNativeSource, mainAccountHolder: string): boolean {
    if (this.isAccountReserved(source.address)) return true;
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
    // Recheck synchronously with taking claims: selection may have awaited chain reads.
    if (sources.some(source => this.isAccountReserved(source.address)))
      throw new RangeError("Account is reserved by another operation; plan the send again");
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

}

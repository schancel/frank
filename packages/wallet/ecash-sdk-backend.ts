/**
 * Custody-internal eCash SDK capability predecessor. The SDK remains the only coin inventory,
 * selector and signer; Chronik owns unspent facts. Imported scripts are explicitly refreshed into
 * that inventory because SDK HD discovery scans only HD indices. No ChainUtxoPool is consulted.
 *
 * This construction view is used by EcashWallet's durable operation owner, which reloads input
 * claims and the HD change floor under a short cross-instance lock and persists intent/signed
 * bytes before exposure. The host owns complete external-payload persistence and its barrier.
 * Imported-key derivation references remain custody's responsibility before recipient enablement.
 * Import must run inside custody from a recipient-derived key, not expose a private-key getter or
 * require messaging/UI to pass keys. No production capability is enabled by this predecessor.
 * Reopening requires custody to re-import keys; this backend never persists private keys.
 */
import type { ChronikClient, ScriptUtxo } from "chronik-client";
import { Address, Ecc, Script, shaRmd160, Tx, sha256d } from "ecash-lib";
import type { EcashNativeOperation } from "./ecash-operation-store";
import type { ChainTransaction } from "./chain/chain-wallet";
import type { EcashAddressPrefix, EcashWalletBackend } from "./ecash-wallet";

interface Keypair {
  sk: Uint8Array;
  pk: Uint8Array;
  pkh: Uint8Array;
  script: Script;
  address: string;
}

/** Only the pinned SDK's public surface, asserted once at its loading boundary. */
export interface EcashSdkWallet extends EcashWalletBackend {
  changeIndex: number;
  utxos: Array<ScriptUtxo & { address: string }>;
  keypairs: Map<string, Keypair>;
  clone(): EcashSdkWallet;
  spendableSatsOnlyUtxos(): Array<ScriptUtxo & { address: string }>;
  updateBalance(): void;
  action(action: {
    outputs: ReadonlyArray<{ address: string; sats: bigint }>;
  }): {
    build(
      sighash?: undefined,
      options?: { skipAutoConsolidateOnMaxTxSize: boolean }
    ): {
      builtTxs: ReadonlyArray<{ txid: string; tx: Tx; fee(): bigint }>;
    };
    inspect(): { fee(): bigint };
  };
}

export interface EcashInputReference {
  readonly txid: string;
  readonly vout: number;
}

export interface EcashNativeConstruction {
  readonly transactions: ReadonlyArray<{
    readonly txid: string;
    readonly rawTransaction: string;
  }>;
  readonly selectedInputs: ReadonlyArray<
    EcashInputReference & { readonly satoshis: bigint }
  >;
  /** Actual input sum minus output sum, including any change below dust. */
  readonly fee: bigint;
  /** Must be durably allocated by the future operation owner before exposure. */
  readonly nextChangeIndex: number;
}

function outpointKey(input: EcashInputReference): string {
  if (
    !/^[0-9a-f]{64}$/.test(input.txid) ||
    !Number.isSafeInteger(input.vout) ||
    input.vout < 0 ||
    input.vout > 0xffffffff
  )
    throw new Error("Invalid eCash input reference");
  return `${input.txid}:${input.vout}`;
}

/** Never exported through a wallet handle; secret material stays at this custody boundary. */
export class EcashSdkBackend implements EcashWalletBackend {
  private readonly imported = new Map<string, Keypair>();

  constructor(
    private readonly sdk: EcashSdkWallet,
    private readonly chronik: ChronikClient,
    private readonly prefix: EcashAddressPrefix
  ) {}

  get balanceSats(): bigint {
    return this.sdk.balanceSats;
  }

  get receiveIndex(): number {
    return this.sdk.receiveIndex;
  }

  getReceiveAddress(index: number): string {
    return this.sdk.getReceiveAddress(index);
  }

  restoreChangeIndex(floor: number): void {
    if (!Number.isSafeInteger(floor) || floor < 0 || floor >= 0x80000000)
      throw new Error("Invalid eCash change allocation");
    this.sdk.changeIndex = Math.max(this.sdk.changeIndex, floor);
  }

  getAvailableBalance(
    excludedInputs: ReadonlyArray<EcashInputReference>
  ): bigint {
    const excluded = new Set(excludedInputs.map(outpointKey));
    return this.sdk.spendableSatsOnlyUtxos().reduce(
      (sum, coin) =>
        excluded.has(
          outpointKey({
            txid: coin.outpoint.txid,
            vout: coin.outpoint.outIdx,
          })
        )
          ? sum
          : sum + coin.sats,
      0n
    );
  }

  inputReferencesFromTransactions(
    rawTransactions: ReadonlyArray<string>
  ): EcashInputReference[] {
    return rawTransactions.flatMap((raw) =>
      Tx.fromHex(raw).inputs.map(({ prevOut }) => ({
        txid:
          typeof prevOut.txid === "string"
            ? prevOut.txid
            : Buffer.from(prevOut.txid).reverse().toString("hex"),
        vout: prevOut.outIdx,
      }))
    );
  }

  validateNativeOperation(operation: EcashNativeOperation): void {
    const tx = Tx.fromHex(operation.transactions[0].rawTransaction);
    const txid = Buffer.from(sha256d(tx.ser())).reverse().toString("hex");
    const inputs = this.inputReferencesFromTransactions([
      operation.transactions[0].rawTransaction,
    ]);
    const recipient = Address.fromCashAddress(operation.intent.recipient);
    const fee =
      operation.inputs.reduce(
        (sum, input) => sum + BigInt(input.satoshis),
        0n
      ) - tx.outputs.reduce((sum, output) => sum + output.sats, 0n);
    if (
      txid !== operation.transactions[0].txid ||
      recipient.prefix !== this.prefix ||
      inputs.length !== operation.inputs.length ||
      inputs.some(
        (input, i) => outpointKey(input) !== outpointKey(operation.inputs[i])
      ) ||
      new Set(inputs.map(outpointKey)).size !== inputs.length ||
      tx.outputs[0]?.sats !== BigInt(operation.intent.value) ||
      tx.outputs[0]?.script.toHex() !== recipient.toScript().toHex() ||
      fee < 0n ||
      fee !== BigInt(operation.fee) ||
      (operation.intent.maxFee !== undefined &&
        fee > BigInt(operation.intent.maxFee))
    )
      throw new Error(
        "Persisted eCash operation does not match its signed transaction"
      );
  }

  validateLegacyTransaction(transaction: ChainTransaction): void {
    const hashes = transaction.rawTransactions?.map((raw) =>
      Buffer.from(sha256d(Tx.fromHex(raw).ser()))
        .reverse()
        .toString("hex")
    );
    if (
      hashes === undefined ||
      hashes.length === 0 ||
      hashes[hashes.length - 1] !== transaction.txHash ||
      (transaction.relatedTxHashes !== undefined &&
        (transaction.relatedTxHashes.length !== hashes.length ||
          transaction.relatedTxHashes.some((hash, i) => hash !== hashes[i])))
    )
      throw new Error(
        "Existing eCash obligation bytes do not match recorded transaction ids"
      );
  }

  async sync(): Promise<void> {
    await this.sdk.sync();
    await this.refreshImportedCoins();
  }

  async syncAndDiscoverAddresses(): Promise<void> {
    await this.sdk.syncAndDiscoverAddresses();
    await this.refreshImportedCoins();
  }

  /** Copies the key and returns only its address. Custody owns re-import after reopening. */
  importSigningKey(secretKey: Uint8Array): string {
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32)
      throw new Error("Expected a 32-byte eCash signing key");
    const sk = Uint8Array.from(secretKey);
    let pk: Uint8Array;
    try {
      pk = new Ecc().derivePubkey(sk);
    } catch (error) {
      sk.fill(0);
      throw error;
    }
    const pkh = shaRmd160(pk);
    const address = Address.p2pkh(pkh, this.prefix).toString();
    if (this.imported.has(address)) {
      sk.fill(0);
      return address;
    }
    if (this.sdk.keypairs.has(address)) {
      sk.fill(0);
      throw new Error("Imported eCash key already belongs to the HD keyring");
    }
    const keypair = { sk, pk, pkh, script: Script.p2pkh(pkh), address };
    this.imported.set(address, keypair);
    this.sdk.keypairs.set(address, keypair);
    return address;
  }

  private async refreshImportedCoins(): Promise<void> {
    if (this.imported.size === 0) return;
    const rows = await Promise.all(
      Array.from(this.imported.values(), async (keypair) => {
        const result = await this.chronik
          .script("p2pkh", Buffer.from(keypair.pkh).toString("hex"))
          .utxos();
        if (result.outputScript !== keypair.script.toHex())
          throw new Error("Chronik returned the wrong imported eCash script");
        return result.utxos.map((utxo) => ({
          ...utxo,
          address: keypair.address,
        }));
      })
    );
    const coins = new Map(
      this.sdk.utxos.map((coin) => [
        outpointKey({ txid: coin.outpoint.txid, vout: coin.outpoint.outIdx }),
        coin,
      ])
    );
    for (const coin of rows.flat()) {
      const key = outpointKey({
        txid: coin.outpoint.txid,
        vout: coin.outpoint.outIdx,
      });
      if (coins.has(key)) throw new Error("Duplicate eCash imported outpoint");
      coins.set(key, coin);
    }
    this.sdk.utxos = Array.from(coins.values());
    this.sdk.updateBalance();
  }

  /** Sign on a clone. No broadcast, claims, HD allocation or original inventory mutation. */
  buildNativeConstruction(params: {
    recipient: string;
    value: bigint;
    excludedInputs: ReadonlyArray<EcashInputReference>;
    changeIndexFloor?: number;
  }): EcashNativeConstruction {
    const recipient = Address.fromCashAddress(params.recipient);
    if (recipient.prefix !== this.prefix)
      throw new Error("Wrong eCash recipient network");
    if (params.value <= 0n) throw new Error("eCash value must be positive");
    const excluded = new Set(params.excludedInputs.map(outpointKey));
    const view = this.sdk.clone();
    if (params.changeIndexFloor !== undefined) {
      if (
        !Number.isSafeInteger(params.changeIndexFloor) ||
        params.changeIndexFloor < 0 ||
        params.changeIndexFloor >= 0x80000000
      )
        throw new Error("Invalid eCash change allocation");
      view.changeIndex = Math.max(view.changeIndex, params.changeIndexFloor);
    }
    view.utxos = view.utxos.filter(
      (coin) =>
        !excluded.has(
          outpointKey({ txid: coin.outpoint.txid, vout: coin.outpoint.outIdx })
        )
    );
    const available = new Map(
      view.utxos.map((coin) => [
        outpointKey({ txid: coin.outpoint.txid, vout: coin.outpoint.outIdx }),
        coin,
      ])
    );
    const built = view
      .action({
        outputs: [{ address: recipient.toString(), sats: params.value }],
      })
      .build(undefined, { skipAutoConsolidateOnMaxTxSize: true });
    if (built.builtTxs.length !== 1)
      throw new Error(
        "eCash construction must not add consolidation transactions"
      );
    const transaction = built.builtTxs[0];
    const selectedInputs = transaction.tx.inputs.map(({ prevOut }) => {
      const reference = {
        txid:
          typeof prevOut.txid === "string"
            ? prevOut.txid
            : Buffer.from(prevOut.txid).reverse().toString("hex"),
        vout: prevOut.outIdx,
      };
      const coin = available.get(outpointKey(reference));
      if (coin === undefined)
        throw new Error("eCash construction selected an unavailable input");
      return Object.freeze({ ...reference, satoshis: coin.sats });
    });
    const fee =
      selectedInputs.reduce((sum, coin) => sum + coin.satoshis, 0n) -
      transaction.tx.outputs.reduce((sum, output) => sum + output.sats, 0n);
    return Object.freeze({
      transactions: Object.freeze([
        Object.freeze({
          txid: transaction.txid,
          rawTransaction: Buffer.from(transaction.tx.ser()).toString("hex"),
        }),
      ]),
      selectedInputs: Object.freeze(selectedInputs),
      fee,
      nextChangeIndex: view.changeIndex,
    });
  }
}

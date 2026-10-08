/**
 * Single-EOA Monad (EVM) transaction construction: build, sign, submit, and track native-value
 * and value+calldata transactions against a single externally-owned account, using ethers.js v6
 * (already the standard for this codebase's Monad-side TS code — see `./monad-http.ts`, ticket
 * #17 — so this module follows suit rather than introducing viem alongside it).
 *
 * Scope (see ticket #11):
 *   - Build + locally sign a plain native-value transfer (recipient, value, no calldata).
 *   - Build + locally sign a value+calldata transaction (recipient, value, arbitrary `data`) —
 *     this is what Stamp burns (#6) will need later: value to an address, commitment bytes in
 *     calldata, in place of the UTXO chain's OP_RETURN output.
 *   - Nonce is fetched fresh from the chain at construction time (via `eth_getTransactionCount`,
 *     `"pending"` tag) — no local caching, guessing, or reuse. That bookkeeping (lease/recovery
 *     for a pool of sub-accounts) is ticket #18's job, not this one's.
 *   - Gas (limit, and fee-per-gas or legacy gas price) is estimated by ethers, not hardcoded,
 *     with every estimated field overridable by the caller.
 *   - Submission goes through `MonadHttpClient.submitRawTransaction` (`eth_sendRawTransaction`).
 *   - Status tracking goes through `MonadHttpClient.getTransactionReceipt`
 *     (`eth_getTransactionReceipt`).
 *
 * Two chain-read handles, on purpose: `MonadHttpClient` (ticket #17) only exposes
 * `submitRawTransaction`/`getTransactionReceipt`/`getLogs`/`getBlockNumber` — it does not expose
 * `eth_getTransactionCount`, `eth_estimateGas`, `eth_feeHistory`/`eth_gasPrice`, or `eth_chainId`,
 * and its internal `ethers.JsonRpcProvider` is a private field with no accessor. Ticket #11's
 * ownership rules forbid touching `monad-http.ts` to add those, so this module takes its own
 * ethers `Provider` (typically another `JsonRpcProvider` pointed at the same RPC URL) to drive
 * nonce lookup, gas/fee estimation, and chain-ID resolution — all via `ethers.Signer.
 * populateTransaction`, i.e. "ethers' estimation" as the ticket allows — while still routing the
 * two operations `MonadHttpClient` *does* own (submit, receipt) through it. Whoever wires up the
 * real `ChainAdapter` assembly (#2) may want to fold these into one client; that consolidation is
 * out of scope here.
 */
import { Provider, Transaction, TransactionRequest, Wallet } from "ethers";

import { MonadTxReceipt } from "./monad-http";

/** The subset of `MonadHttpClient` this module depends on, expressed as a structural interface
 * (rather than importing the `MonadHttpClient` class type directly) so unit tests can supply a
 * plain mock object without needing to satisfy the class's private internal field. The real
 * `MonadHttpClient` already implements this shape. */
export interface MonadTxSubmitter {
  submitRawTransaction(rawTxHex: string): Promise<string>;
  getTransactionReceipt(txHash: string): Promise<MonadTxReceipt | undefined>;
}

/** Explicit overrides for any field this module would otherwise fetch/estimate. Per the ticket,
 * nothing is hardcoded — passing an override simply skips the corresponding chain read for that
 * field (see `ethers`' `Signer.populateTransaction`, which only queries the provider for fields
 * left `undefined`). */
export interface MonadTxOverrides {
  /** Overrides the freshly-fetched `eth_getTransactionCount` nonce. Only intended for tests or
   * for a future caller (ticket #18) that has its own nonce-leasing logic; this ticket's own
   * construction path always fetches fresh when this is omitted. */
  nonce?: number;
  gasLimit?: bigint;
  /** EIP-1559 fee cap. Leave both this and `maxPriorityFeePerGas` unset to let ethers pick via
   * `eth_feeHistory`/`eth_gasPrice` (auto-detecting EIP-1559 vs. legacy support). */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Legacy (pre-EIP-1559) gas price; mutually exclusive with the two fields above. */
  gasPrice?: bigint;
  chainId?: bigint;
}

/** A fully built and locally-signed Monad transaction, ready to submit as-is. All chain-dependent
 * fields (`nonce`, `gasLimit`, fee fields, `chainId`) are the actual resolved values used when
 * signing — never placeholders — so callers/tests can assert on them directly. */
export interface SignedMonadTx {
  /** 0x-prefixed signed raw transaction, ready for `eth_sendRawTransaction`. */
  rawTx: string;
  /** Locally-computed transaction hash (keccak256 of the signed encoding) — this must match the
   * hash the node returns from `eth_sendRawTransaction` on submit; see `submit()`. */
  txHash: string;
  from: string;
  to: string;
  value: bigint;
  /** `'0x'` for a plain value transfer. */
  data: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined;
  gasPrice: bigint | undefined;
  chainId: bigint;
}

/** Fully resolved ordinary Ethereum bytes. Public identity is checked again at signing. */
export interface FrozenUnsignedMonadTx {
  readonly from: string;
  readonly unsignedSerialized: string;
}

export type MonadTxStatus = "pending" | "confirmed" | "failed";

/**
 * Builds, signs, submits, and tracks Monad transactions for a single EOA held in memory (a raw
 * private key). HD derivation, a pool of sub-accounts, and fan-out funding are explicitly out of
 * scope (tickets #14/#18) — this class only ever manages the one key it's constructed with.
 */
export class MonadAccountTxSigner {
  private readonly wallet: Wallet;
  private readonly httpClient: MonadTxSubmitter;

  /**
   * @param privateKey 0x-prefixed hex private key for the single EOA this instance signs for.
   * @param provider ethers `Provider` used for nonce/gas/fee/chainId reads (see file header for
   *   why this is separate from `httpClient`).
   * @param httpClient Used for `submitRawTransaction`/`getTransactionReceipt` (submit + track).
   */
  constructor(params: {
    privateKey: string;
    provider: Provider;
    httpClient: MonadTxSubmitter;
  }) {
    this.wallet = new Wallet(params.privateKey, params.provider);
    this.httpClient = params.httpClient;
  }

  /** The EOA address this instance signs for. */
  get address(): string {
    return this.wallet.address;
  }

  /** Build and locally sign a plain native-value transfer: `value` MON (in wei) to `to`, no
   * calldata. This is the primitive the fan-out funding subticket (#14) will call repeatedly. */
  async buildAndSignTransfer(
    to: string,
    value: bigint,
    overrides: MonadTxOverrides = {}
  ): Promise<SignedMonadTx> {
    return this.buildAndSign(to, value, "0x", overrides);
  }

  /** Build and locally sign a value+calldata transaction: `value` MON (in wei) to `to`, carrying
   * arbitrary `data`. This is the primitive Stamp-over-Monad (#6) will use to burn value to an
   * address while attaching a commitment in calldata, in place of the UTXO chain's OP_RETURN
   * output. */
  async buildAndSignCall(
    to: string,
    value: bigint,
    data: string,
    overrides: MonadTxOverrides = {}
  ): Promise<SignedMonadTx> {
    if (data === undefined || data === "" || data === "0x") {
      throw new Error(
        "buildAndSignCall requires non-empty calldata; use buildAndSignTransfer for plain value transfers"
      );
    }
    return this.buildAndSign(to, value, data, overrides);
  }

  /** Resolve quotes without creating a signature or submitting any transaction. */
  async populateUnsignedCall(
    to: string,
    value: bigint,
    data: string,
    overrides: MonadTxOverrides = {}
  ): Promise<FrozenUnsignedMonadTx> {
    if (!data || data === "0x")
      throw new Error("Canonical call requires calldata");
    return this.populateUnsigned(to, value, data, overrides);
  }

  /** Resolve quotes for a plain value transfer with empty calldata, without signing or
   * submitting. A canonical direct-message stamp payment is exactly this: nothing in the
   * transaction marks it as a Frank payment. */
  async populateUnsignedTransfer(
    to: string,
    value: bigint,
    overrides: MonadTxOverrides = {}
  ): Promise<FrozenUnsignedMonadTx> {
    return this.populateUnsigned(to, value, "0x", overrides);
  }

  private async populateUnsigned(
    to: string,
    value: bigint,
    data: string,
    overrides: MonadTxOverrides
  ): Promise<FrozenUnsignedMonadTx> {
    const cleanOverrides = { ...overrides };
    if (
      cleanOverrides.maxFeePerGas !== undefined ||
      cleanOverrides.maxPriorityFeePerGas !== undefined
    ) {
      delete cleanOverrides.gasPrice;
    }
    const populated = await this.wallet.populateTransaction({
      to,
      value,
      data,
      ...cleanOverrides,
    });
    const { from, ...unsignedFields } = populated;
    if (
      typeof from !== "string" ||
      from.toLowerCase() !== this.address.toLowerCase()
    )
      throw new Error("Canonical populated sender mismatch");
    const transaction = Transaction.from(unsignedFields);
    if (
      transaction.data.toLowerCase() !== data.toLowerCase() ||
      transaction.to === null ||
      transaction.chainId <= 0n ||
      transaction.gasLimit <= 0n ||
      transaction.value <= 0n ||
      (transaction.type !== 0 && transaction.type !== 2) ||
      (transaction.type === 0
        ? transaction.gasPrice === null
        : transaction.maxFeePerGas === null ||
          transaction.maxPriorityFeePerGas === null)
    )
      throw new Error("Incomplete canonical unsigned transaction");
    return Object.freeze({
      from: this.address.toLowerCase(),
      unsignedSerialized: transaction.unsignedSerialized,
    });
  }

  /** Sign exactly previously persisted unsigned bytes; never reads nonce, fees or gas. */
  async signFrozenUnsigned(
    input: FrozenUnsignedMonadTx
  ): Promise<SignedMonadTx> {
    if (input.from !== this.address.toLowerCase())
      throw new Error("Canonical unsigned sender mismatch");
    const transaction = Transaction.from(input.unsignedSerialized);
    if (
      transaction.signature !== null ||
      transaction.unsignedSerialized !== input.unsignedSerialized ||
      transaction.to === null ||
      transaction.chainId <= 0n ||
      transaction.gasLimit <= 0n ||
      transaction.value <= 0n ||
      (transaction.type !== 0 && transaction.type !== 2)
    )
      throw new Error("Invalid canonical unsigned transaction");
    const rawTx = await this.wallet.signTransaction(transaction);
    const parsed = Transaction.from(rawTx);
    if (
      parsed.unsignedSerialized !== input.unsignedSerialized ||
      parsed.from?.toLowerCase() !== input.from ||
      parsed.hash === null
    )
      throw new Error("Canonical signed transaction mismatch");
    return {
      rawTx,
      txHash: parsed.hash,
      from: parsed.from!,
      to: parsed.to!,
      value: parsed.value,
      data: parsed.data,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      maxFeePerGas: parsed.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? undefined,
      gasPrice: parsed.gasPrice ?? undefined,
      chainId: parsed.chainId,
    };
  }

  private async buildAndSign(
    to: string,
    value: bigint,
    data: string,
    overrides: MonadTxOverrides
  ): Promise<SignedMonadTx> {
    const request: TransactionRequest = { to, value, data };
    if (overrides.nonce !== undefined) request.nonce = overrides.nonce;
    if (overrides.gasLimit !== undefined) request.gasLimit = overrides.gasLimit;
    if (overrides.maxFeePerGas !== undefined) {
      request.maxFeePerGas = overrides.maxFeePerGas;
    }
    if (overrides.maxPriorityFeePerGas !== undefined) {
      request.maxPriorityFeePerGas = overrides.maxPriorityFeePerGas;
    }
    if (overrides.gasPrice !== undefined) request.gasPrice = overrides.gasPrice;
    if (overrides.chainId !== undefined) request.chainId = overrides.chainId;

    // `populateTransaction` fills in whatever wasn't explicitly overridden above by querying
    // `this.wallet.provider`: nonce via `eth_getTransactionCount(address, "pending")`, gasLimit
    // via `eth_estimateGas`, fee fields via `eth_feeHistory`/`eth_gasPrice` (auto-detecting
    // EIP-1559 support), and chainId via `eth_chainId`. See `ethers`'
    // `AbstractSigner.populateTransaction` (providers/abstract-signer.ts).
    const populated = await this.wallet.populateTransaction(request);
    const rawTx = await this.wallet.signTransaction(populated);

    // Re-derive every field from the signed encoding itself (rather than trusting `populated`
    // directly) so `SignedMonadTx` reflects exactly what was signed, byte for byte.
    const parsed = Transaction.from(rawTx);
    if (parsed.to === null) {
      // Only possible for contract-creation txs (`to` omitted), which this module never builds.
      throw new Error("Signed transaction unexpectedly has no `to` address");
    }
    if (parsed.hash === null) {
      throw new Error("Signed transaction unexpectedly has no hash");
    }

    return {
      rawTx,
      txHash: parsed.hash,
      from: parsed.from ?? this.wallet.address,
      to: parsed.to,
      value: parsed.value,
      data: parsed.data,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      maxFeePerGas: parsed.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? undefined,
      gasPrice: parsed.gasPrice ?? undefined,
      chainId: parsed.chainId,
    };
  }

  /** Submit an already-built, already-signed transaction via `MonadHttpClient.
   * submitRawTransaction` (`eth_sendRawTransaction`). Returns the transaction hash the node
   * reports, after checking it matches the hash computed locally at sign time — a mismatch would
   * indicate a serialization bug and should never happen in practice. */
  async submit(signedTx: SignedMonadTx): Promise<string> {
    return this.submitRaw(signedTx.rawTx, signedTx.txHash);
  }

  /** Replays a previously journaled signed transaction without reconstructing or re-signing it. */
  async submitRaw(rawTx: string, expectedTxHash: string): Promise<string> {
    const broadcastHash = await this.httpClient.submitRawTransaction(rawTx);
    if (broadcastHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
      throw new Error(
        `Broadcast tx hash (${broadcastHash}) does not match the hash computed at sign time (${expectedTxHash})`
      );
    }
    return broadcastHash;
  }

  /** Track a submitted transaction's status via `MonadHttpClient.getTransactionReceipt`
   * (`eth_getTransactionReceipt`). `'pending'` if the node has no receipt yet (unknown/unmined),
   * `'confirmed'`/`'failed'` once it does. A receipt with `status: 'unknown'` (pre-Byzantium-style
   * receipts with no status field) is treated as `'confirmed'`, since reaching a receipt at all
   * means the tx was mined — Monad, a modern EVM chain, should never actually produce this case
   * (see `MonadTxReceipt`'s doc comment in `monad-http.ts`). */
  async getStatus(txHash: string): Promise<MonadTxStatus> {
    const receipt = await this.httpClient.getTransactionReceipt(txHash);
    if (receipt === undefined) return "pending";
    return receipt.status === "failure" ? "failed" : "confirmed";
  }

  /** Read native balance (in wei) for an address (or this signer's own address). */
  async getBalance(address?: string): Promise<bigint> {
    const target = address ?? this.address;
    return (this.wallet.provider as Provider).getBalance(target);
  }

  /** Read on-chain transaction count (nonce) for an address (or this signer's own address). */
  async getTransactionCount(address?: string): Promise<bigint> {
    const target = address ?? this.address;
    const count = await (this.wallet.provider as Provider).getTransactionCount(
      target,
      "latest"
    );
    return BigInt(count);
  }
}

/**
 * The wallet's boundary to the Lotus v2 chain objects in `@frank/nakamoto/lotus-v2`.
 *
 * Nakamoto owns every Lotus v2 byte: addresses, the keyhash template, v7 framing, TxID and
 * BIP340 signing. This module adds only what is the wallet's: the regtest-only rule, hex at the
 * storage and indexer boundaries, and the node's JSON-RPC id order.
 *
 * Owner rule (2026-11-19): native v7 transactions are rejected outside regtest. There is
 * deliberately no mainnet or testnet value here, so no wallet code can build, sign or address
 * one; {@link requireLotusV2Network} turns any other input into an explicit unsupported error.
 * (Nakamoto has no Lotus v2 mainnet or testnet descriptor either: they are not yet defined.)
 *
 * Hex conventions: a transaction id here is the BLAKE3 output in wire order, as the node's
 * Chronik `/v2/*` routes print it. The node's JSON-RPC prints ids byte-reversed (Bitcoin
 * display order); convert with {@link rpcTxid} only at that boundary.
 */
import { privateKeyFromSecretBytes, publicFromPrivate, signingKey } from "@frank/nakamoto";
import {
  decodeLotusV2Address,
  encodeLotusV2KeyhashAddress,
  LOTUS_V2_REGTEST,
  lotusV2BranchLeaf,
  lotusV2Keyhash,
  lotusV2KeyhashTemplate,
  lotusV2TemplatePaymentSize,
  signLotusV2Transaction,
  type LotusV2ChainDescriptor,
  type LotusV2Output,
} from "@frank/nakamoto/lotus-v2";
import { randomBytes } from "@noble/hashes/utils";

export type LotusV2Network = "regtest";

export class LotusV2UnsupportedNetworkError extends Error {
  constructor(readonly requested: string) {
    super(
      `Lotus v2 native transactions are supported only on regtest, not on ${JSON.stringify(requested)}`
    );
    this.name = "LotusV2UnsupportedNetworkError";
  }
}

/** Boundary check for any network value that reaches the wallet from outside it. */
export function requireLotusV2Network(network: string): LotusV2Network {
  if (network !== "regtest") throw new LotusV2UnsupportedNetworkError(network);
  return network;
}

/** The nakamoto descriptor of a network the wallet supports. */
export function lotusV2Chain(network: LotusV2Network): LotusV2ChainDescriptor {
  requireLotusV2Network(network);
  return LOTUS_V2_REGTEST;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string, length?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(text) || (length !== undefined && text.length !== length * 2))
    throw new Error(`Expected lowercase hex${length === undefined ? "" : ` of ${length} bytes`}`);
  return Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** Node JSON-RPC display order <-> wire order (byte reversal; its own inverse). */
export function rpcTxid(txid: string): string {
  return toHex(fromHex(txid, 32).reverse());
}

/**
 * The 32-byte branch root an address locks coins to, hex. Throws the spec's rejection reason
 * (`mixed case`, `bad checksum`, …) for a malformed address, and
 * {@link LotusV2UnsupportedNetworkError} for a well-formed address of another network.
 */
export function lotusV2AddressRoot(network: LotusV2Network, address: string): string {
  const decoded = decodeLotusV2Address(lotusV2Chain(network), address);
  if (decoded.ok) return toHex(decoded.value.root);
  const { code, network: other } = decoded.error;
  if ((code === "network-not-defined" || code === "wrong-network") && other)
    throw new LotusV2UnsupportedNetworkError(other);
  throw new Error(code.replace(/-/g, " "));
}

/** The x-only BIP340 key of a 32-byte secret. */
export function lotusV2XOnlyKey(secret: Uint8Array): Uint8Array {
  const key = privateKeyFromSecretBytes(secret, true);
  if (!key.ok) throw new Error(`Invalid Lotus key: ${key.error.code}`);
  const point = publicFromPrivate(key.value);
  key.value.bytes.fill(0);
  if (!point.ok) throw new Error(`Invalid Lotus key: ${point.error.code}`);
  return Uint8Array.from(point.value.xOnly);
}

/** The type-1 keyhash address, branch root and spend template of an x-only key. */
export function lotusV2KeyhashDestination(network: LotusV2Network, xOnlyPublicKey: Uint8Array) {
  const chain = lotusV2Chain(network);
  const template = lotusV2KeyhashTemplate(xOnlyPublicKey);
  return {
    address: encodeLotusV2KeyhashAddress(chain, lotusV2Keyhash(xOnlyPublicKey)),
    root: toHex(lotusV2BranchLeaf(chain, template.script)),
    template,
  };
}

/** One coin the wallet spends, with the key that owns it (its type-1 program is the coin's only branch). */
export interface KeyhashSpend {
  readonly txid: string;
  readonly outIdx: number;
  readonly value: bigint;
  /** 32-byte secp256k1 secret. */
  readonly secret: Uint8Array;
}

/** A native spendable output: one branch root (hex), path `[[0]]`. */
export interface NativeOutput {
  readonly value: bigint;
  readonly root: string;
}

export interface SignedNativeTransaction {
  readonly txid: string;
  readonly txhash: string;
  readonly raw: string;
  readonly size: number;
}

const ANY_KEYHASH_TEMPLATE = lotusV2KeyhashTemplate(new Uint8Array(32));

/** Exact signed size of an ordinary keyhash payment, known before signing (FULL signatures). */
export function keyhashPaymentSize(inputCount: number, outputCount: number): number {
  return lotusV2TemplatePaymentSize(ANY_KEYHASH_TEMPLATE, inputCount, outputCount);
}

const oneBranch = (value: bigint, root: string): LotusV2Output => ({
  value,
  branches: [fromHex(root, 32)],
  paths: [[0]],
});

/**
 * Build and sign one ordinary payment through nakamoto: every input a type-1 keyhash coin,
 * every output native spendable, FULL signatures. The fee is the input total minus the output
 * total.
 */
export function signKeyhashPayment(params: {
  readonly network: LotusV2Network;
  readonly inputs: readonly KeyhashSpend[];
  readonly outputs: readonly NativeOutput[];
}): SignedNativeTransaction {
  const chain = lotusV2Chain(params.network);
  if (params.inputs.length === 0 || params.outputs.length === 0)
    throw new Error("A transaction needs an input and an output");
  const totalIn = params.inputs.reduce((sum, input) => sum + input.value, 0n);
  const totalOut = params.outputs.reduce((sum, output) => sum + output.value, 0n);
  if (totalOut > totalIn) throw new Error("Outputs exceed inputs");
  // Fresh BIP340 auxiliary randomness per payment.
  const aux = randomBytes(32);
  try {
    const inputs = params.inputs.map((spend) => {
      const key = privateKeyFromSecretBytes(spend.secret, true);
      if (!key.ok) throw new Error(`Invalid Lotus key: ${key.error.code}`);
      const signer = signingKey("schnorr", { key: key.value, aux });
      key.value.bytes.fill(0);
      if (!signer.ok) throw new Error(`Invalid Lotus key: ${signer.error.code}`);
      const destination = lotusV2KeyhashDestination(params.network, signer.value.publicKey);
      return {
        prevTxid: fromHex(spend.txid, 32),
        prevIndex: spend.outIdx,
        coin: oneBranch(spend.value, destination.root),
        template: destination.template,
        signer: signer.value,
      };
    });
    const signed = signLotusV2Transaction({
      chain,
      inputs,
      outputs: params.outputs.map((output) => oneBranch(output.value, output.root)),
    });
    if (signed.raw.length !== keyhashPaymentSize(inputs.length, params.outputs.length))
      throw new Error("Unexpected native transaction size");
    return {
      txid: toHex(signed.txid),
      txhash: toHex(signed.txhash),
      raw: toHex(signed.raw),
      size: signed.raw.length,
    };
  } finally {
    aux.fill(0);
  }
}

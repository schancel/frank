/**
 * Lotus v2 native (version 7) transactions and `xpi1` addresses: the pure codec.
 *
 * This file is the only place Frank encodes, hashes or signs a Lotus v2 transaction. It covers
 * exactly what an ordinary wallet needs and nothing else:
 *
 * - type-1 keyhash addresses (`rxpi1p…`), whose program is `DUP BLAKE3 PUSH32(keyhash)
 *   EQUALVERIFY CHECKSIG` over the BLAKE3 of an x-only BIP340 public key, and paying a type-0
 *   address (an explicit branch root);
 * - native spendable outputs (`flags = 0`) with one branch and path `[[0]]`;
 * - spending such outputs with FULL-mode BIP340 signatures;
 * - the BLAKE3 TxID (`H_txid`) and complete hash (`H_txhash`).
 *
 * Sources: the node's `docs/lotus-v2/addresses.md`, `consensus.md` (C07, C18) and the
 * `@lotus/v2-payment-compiler` transaction runtime in the Lotus repository
 * (`tools/lotus-v2-compiler/src/transaction-runtime.ts`), whose framing this follows. That
 * package is not published, so it is not a dependency; the real-node tests in
 * `lotus-v2-wallet.regtest.jest.test.ts` are what prove these bytes against `lotusd`.
 *
 * Hex conventions: a transaction id here is the BLAKE3 output in wire order, as the node's
 * Chronik `/v2/*` routes print it. The node's JSON-RPC prints ids byte-reversed (Bitcoin
 * display order); convert with {@link rpcTxid} only at that boundary.
 *
 * ecash-lib must never parse, hash or sign these transactions: it computes a wrong id for v7.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { blake3 } from "@noble/hashes/blake3";

/**
 * The only network Frank builds Lotus v2 native transactions for. Owner rule (2026-11-19): v7
 * transactions are rejected outside regtest. There is deliberately no mainnet or testnet value
 * here, so no caller can build, sign or address one; {@link requireLotusV2Network} turns any
 * other input into an explicit unsupported error at the boundary.
 */
export type LotusV2Network = "regtest";

export class LotusV2UnsupportedNetworkError extends Error {
  constructor(readonly requested: string) {
    super(
      `Lotus v2 native transactions are supported only on regtest, not on ${JSON.stringify(requested)}`
    );
    this.name = "LotusV2UnsupportedNetworkError";
  }
}

/** Boundary check for any network value that reaches the codec from outside it. */
export function requireLotusV2Network(network: string): LotusV2Network {
  if (network !== "regtest") throw new LotusV2UnsupportedNetworkError(network);
  return network;
}

/** 32-byte ChainID committed in every id and signature (`V2_REGTEST_CHAIN_ID{}`). */
export const LOTUS_V2_REGTEST_CHAIN_ID = "00".repeat(32);

const HRP = "rxpi";
/** Checksum constants of every Lotus v2 prefix, so a mainnet/testnet address is recognised
 * (and refused as unsupported) instead of being reported as malformed. */
const CHECKSUM_CONSTANT: Readonly<Record<string, bigint>> = Object.freeze({
  xpi: 0xb70061479en,
  txpi: 0xadda0f1635n,
  rxpi: 0x8172b45d63n,
});
const PREFIX_NETWORK: Readonly<Record<string, string>> = Object.freeze({
  xpi: "mainnet",
  txpi: "testnet",
  rxpi: "regtest",
});

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];
export const SEQUENCE_FINAL = 0xffffffff;
const TX_VERSION = 7;
/** FULL signature mode byte in the signing message (P01). */
const SIGHASH_FULL = 0;

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(text: string, length?: number): Uint8Array {
  if (
    !/^(?:[0-9a-f]{2})*$/.test(text) ||
    (length !== undefined && text.length !== length * 2)
  )
    throw new Error(
      `Expected lowercase hex${length === undefined ? "" : ` of ${length} bytes`}`
    );
  return Uint8Array.from(Buffer.from(text, "hex"));
}

/** Node JSON-RPC display order <-> wire order (byte reversal; its own inverse). */
export function rpcTxid(txid: string): string {
  return toHex(fromHex(txid, 32).reverse());
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(parts));
}

function uint(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8))
    throw new RangeError(`u${bytes * 8} out of range`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(value & 255n);
    value >>= 8n;
  }
  return out;
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value)) throw new RangeError("u32 out of range");
  return uint(BigInt(value), 4);
}

/** Bitcoin CompactSize. */
function compactSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Invalid CompactSize");
  if (n < 253) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(253, n & 255, n >> 8);
  if (n <= 0xffffffff) return concat(Uint8Array.of(254), uint(BigInt(n), 4));
  return concat(Uint8Array.of(255), uint(BigInt(n), 8));
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concat(compactSize(bytes.length), bytes);
}

/** `H_name(x) = BLAKE3("Lotus/v2/<name>\0" || x)`. */
function tagged(name: string, payload: Uint8Array): Uint8Array {
  return blake3(concat(new TextEncoder().encode(`Lotus/v2/${name}\0`), payload));
}

/** P02 `IndexedTreeRoot`: bottom-up indexed binary Merkle root, zero-padded odd levels. */
function indexedRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return tagged("merkleidx", Uint8Array.of(2));
  let nodes = [...leaves];
  let level = 0;
  while (nodes.length > 1) {
    if (nodes.length & 1) nodes.push(new Uint8Array(32));
    const next: Uint8Array[] = [];
    for (let i = 0; i < nodes.length; i += 2)
      next.push(
        tagged(
          "merkleidx",
          concat(Uint8Array.of(1), uint(BigInt(level), 2), nodes[i]!, nodes[i + 1]!)
        )
      );
    nodes = next;
    level++;
  }
  return nodes[0]!;
}

// --- Keys, programs and addresses -----------------------------------------------------------

/** 32-byte x-only BIP340 public key of a 32-byte secret. */
export function xOnlyPublicKey(secret: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(secret);
}

/** Type-1 payload: unkeyed BLAKE3 of the x-only key. */
export function keyhashOf(xOnly: Uint8Array): Uint8Array {
  if (xOnly.length !== 32) throw new Error("Expected a 32-byte x-only key");
  return blake3(xOnly);
}

/** The exact 37-byte type-1 program: `DUP BLAKE3 PUSH32(keyhash) EQUALVERIFY CHECKSIG`. */
export function keyhashProgram(keyhash: Uint8Array): Uint8Array {
  if (keyhash.length !== 32) throw new Error("Expected a 32-byte keyhash");
  return concat(Uint8Array.of(0x7a, 0xba, 0x20), keyhash, Uint8Array.of(0x92, 0xbb));
}

/** `Leaf(script) = H_branch(0x00 || Bytes(script))`. */
export function branchLeaf(program: Uint8Array): Uint8Array {
  return tagged("branch", concat(Uint8Array.of(0), lengthPrefixed(program)));
}

/** A decoded address: what the payer must lock coins to. */
export type LotusV2Destination =
  | { readonly type: 0; readonly root: string }
  | { readonly type: 1; readonly keyhash: string; readonly root: string };

function polymod(symbols: readonly number[]): bigint {
  let c = 1n;
  for (const d of symbols) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i]!;
  }
  return c;
}

function encodeBody(network: LotusV2Network, type: 0 | 1, payload: Uint8Array): string {
  requireLotusV2Network(network);
  const hrp = HRP;
  let p = BigInt(`0x${toHex(payload)}`) << 4n;
  const data: number[] = [type];
  const groups: number[] = [];
  for (let i = 0; i < 52; i++) {
    groups.unshift(Number(p & 31n));
    p >>= 5n;
  }
  data.push(...groups);
  const mod = polymod([...data, 0, 0, 0, 0, 0, 0, 0, 0]) ^ CHECKSUM_CONSTANT[hrp]!;
  for (let i = 0; i < 8; i++) data.push(Number((mod >> BigInt(5 * (7 - i))) & 31n));
  return `${hrp}1${data.map((d) => CHARSET[d]).join("")}`;
}

export function encodeKeyhashAddress(network: LotusV2Network, keyhash: Uint8Array): string {
  if (keyhash.length !== 32) throw new Error("Expected a 32-byte keyhash");
  return encodeBody(network, 1, keyhash);
}

/** Decode an address of `network`; throws with the reference reason for anything else. */
export function decodeAddress(network: LotusV2Network, input: string): LotusV2Destination {
  if (input !== input.toLowerCase() && input !== input.toUpperCase())
    throw new Error("mixed case");
  const text = input.toLowerCase();
  const split = text.lastIndexOf("1");
  const hrp = text.slice(0, split);
  requireLotusV2Network(network);
  if (split < 0 || CHECKSUM_CONSTANT[hrp] === undefined) throw new Error("unknown prefix");
  if (hrp !== HRP) {
    const other = PREFIX_NETWORK[hrp]!;
    // A well-formed address of a network Frank does not support is unsupported, not a typo.
    throw new LotusV2UnsupportedNetworkError(other);
  }
  const body = text.slice(split + 1);
  if (body.length !== 61) throw new Error("bad length");
  const symbols = [...body].map((ch) => CHARSET.indexOf(ch));
  if (symbols.some((s) => s < 0)) throw new Error("bad character");
  if (polymod(symbols) !== CHECKSUM_CONSTANT[hrp]) throw new Error("bad checksum");
  const type = symbols[0]!;
  if (type !== 0 && type !== 1) throw new Error("unknown version");
  let p = 0n;
  for (const s of symbols.slice(1, 53)) p = p * 32n + BigInt(s);
  if ((p & 15n) !== 0n) throw new Error("nonzero padding");
  const payload = (p >> 4n).toString(16).padStart(64, "0");
  if (type === 0) return { type: 0, root: payload };
  return {
    type: 1,
    keyhash: payload,
    root: toHex(branchLeaf(keyhashProgram(fromHex(payload, 32)))),
  };
}

// --- Outputs and transactions ----------------------------------------------------------------

/** A native spendable output: one branch root, path `[[0]]`. */
export interface NativeOutput {
  readonly value: bigint;
  /** 32-byte branch root, hex. */
  readonly root: string;
}

/** `Bytes(Output)` for a native spendable single-branch output. */
export function encodeOutput(output: NativeOutput): Uint8Array {
  return concat(
    Uint8Array.of(0),
    uint(output.value, 8),
    compactSize(1),
    fromHex(output.root, 32),
    compactSize(1),
    compactSize(1),
    compactSize(0)
  );
}

/** One coin the wallet spends, with the key that owns it. */
export interface KeyhashSpend {
  readonly txid: string;
  readonly outIdx: number;
  readonly value: bigint;
  /** 32-byte secp256k1 secret; its type-1 program must be the coin's only branch. */
  readonly secret: Uint8Array;
  readonly sequence?: number;
}

export interface SignedNativeTransaction {
  readonly txid: string;
  readonly txhash: string;
  readonly raw: string;
  readonly size: number;
}

interface PreparedInput {
  readonly spend: KeyhashSpend;
  readonly xOnly: Uint8Array;
  readonly program: Uint8Array;
  readonly leaf: Uint8Array;
  readonly coin: NativeOutput;
}

function inputCore(input: PreparedInput): Uint8Array {
  return concat(
    fromHex(input.spend.txid, 32),
    u32(input.spend.outIdx),
    u32(input.spend.sequence ?? SEQUENCE_FINAL),
    Uint8Array.of(1), // spend input
    compactSize(0), // path index
    compactSize(1), // one witness for the one-branch path
    lengthPrefixed(input.program),
    compactSize(0) // no proof siblings for a one-leaf root
  );
}

function inputFull(input: PreparedInput, signature: Uint8Array): Uint8Array {
  // Argument stack is [signature, xonly_public_key], the public key on top.
  return concat(
    inputCore(input),
    compactSize(2),
    lengthPrefixed(signature),
    lengthPrefixed(input.xOnly)
  );
}

/** Exact signed size, known before signing (FULL signatures are always 64 bytes). */
export function nativeTransactionSize(inputCount: number, outputCount: number): number {
  const header = 4 + 8 + 2 + 2;
  const input = 32 + 4 + 4 + 1 + 1 + 1 + (1 + 37) + 1 + 1 + (1 + 64) + (1 + 32);
  const output = 1 + 8 + 1 + 32 + 1 + 1 + 1;
  return header + inputCount * input + outputCount * output;
}

/**
 * Build and sign one ordinary transaction. Every input is a type-1 keyhash coin of `secret`;
 * outputs are native spendable. The fee is the input total minus the output total.
 */
export function signNativeTransaction(params: {
  readonly network: LotusV2Network;
  readonly inputs: readonly KeyhashSpend[];
  readonly outputs: readonly NativeOutput[];
  readonly lock?: bigint;
}): SignedNativeTransaction {
  requireLotusV2Network(params.network);
  const chainId = fromHex(LOTUS_V2_REGTEST_CHAIN_ID, 32);
  if (params.inputs.length === 0 || params.outputs.length === 0)
    throw new Error("A transaction needs an input and an output");
  if (params.inputs.length > 256 || params.outputs.length > 256)
    throw new Error("Too many inputs or outputs");
  const seen = new Set<string>();
  const prepared: PreparedInput[] = params.inputs.map((spend) => {
    const key = `${spend.txid}:${spend.outIdx}`;
    if (seen.has(key)) throw new Error("Duplicate input");
    seen.add(key);
    const xOnly = xOnlyPublicKey(spend.secret);
    const program = keyhashProgram(keyhashOf(xOnly));
    const leaf = branchLeaf(program);
    return { spend, xOnly, program, leaf, coin: { value: spend.value, root: toHex(leaf) } };
  });
  const totalIn = prepared.reduce((sum, input) => sum + input.coin.value, 0n);
  const totalOut = params.outputs.reduce((sum, output) => sum + output.value, 0n);
  if (totalOut > totalIn) throw new Error("Outputs exceed inputs");
  const header = concat(
    u32(TX_VERSION),
    uint(params.lock ?? 0n, 8),
    uint(BigInt(prepared.length), 2),
    uint(BigInt(params.outputs.length), 2)
  );
  const outputs = params.outputs.map(encodeOutput);
  const outputsRoot = indexedRoot(outputs.map((o) => tagged("output", lengthPrefixed(o))));
  const txid = tagged(
    "txid",
    concat(
      chainId,
      header,
      indexedRoot(prepared.map((input) => tagged("inputcore", inputCore(input)))),
      outputsRoot
    )
  );
  const coinsRoot = indexedRoot(
    prepared.map((input) => tagged("coinentry", lengthPrefixed(encodeOutput(input.coin))))
  );
  const full = prepared.map((input, index) => {
    const selector = concat(Uint8Array.of(1), u32(index), u32(0), input.leaf);
    const message = tagged(
      "sighash",
      concat(chainId, Uint8Array.of(SIGHASH_FULL), txid, coinsRoot, selector)
    );
    const signature = schnorr.sign(message, input.spend.secret);
    return inputFull(input, signature);
  });
  const txhash = tagged(
    "txhash",
    concat(
      chainId,
      header,
      indexedRoot(full.map((input) => tagged("inputfull", input))),
      outputsRoot
    )
  );
  const raw = concat(header, ...full, ...outputs);
  if (raw.length !== nativeTransactionSize(prepared.length, outputs.length))
    throw new Error("Unexpected native transaction size");
  return { txid: toHex(txid), txhash: toHex(txhash), raw: toHex(raw), size: raw.length };
}

/** The id a raw transaction from {@link signNativeTransaction} commits to, recomputed from bytes. */
export function nativeTransactionId(network: LotusV2Network, raw: string): string {
  requireLotusV2Network(network);
  const bytes = fromHex(raw);
  let at = 0;
  const take = (n: number) => {
    if (at + n > bytes.length) throw new Error("Truncated native transaction");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const readCompact = () => {
    const first = take(1)[0]!;
    if (first < 253) return first;
    if (first === 253) {
      const b = take(2);
      return b[0]! | (b[1]! << 8);
    }
    throw new Error("Unsupported CompactSize in a wallet transaction");
  };
  const header = take(16);
  const version = header[0]! | (header[1]! << 8) | (header[2]! << 16) | (header[3]! << 24);
  if (version !== TX_VERSION) throw new Error("Not a native v7 transaction");
  const inputCount = header[12]! | (header[13]! << 8);
  const outputCount = header[14]! | (header[15]! << 8);
  const cores: Uint8Array[] = [];
  for (let i = 0; i < inputCount; i++) {
    const start = at;
    take(32 + 4 + 4);
    if (take(1)[0] !== 1) throw new Error("Only spend inputs are supported");
    readCompact();
    const witnesses = readCompact();
    for (let w = 0; w < witnesses; w++) {
      take(readCompact());
      take(32 * readCompact());
    }
    cores.push(bytes.slice(start, at));
    for (let w = 0; w < witnesses; w++) {
      const args = readCompact();
      for (let a = 0; a < args; a++) take(readCompact());
    }
  }
  const outputs: Uint8Array[] = [];
  for (let i = 0; i < outputCount; i++) {
    const start = at;
    const flags = take(1)[0]!;
    take(8);
    if (flags & 1) take(32);
    take(32 * readCompact());
    const paths = readCompact();
    for (let p = 0; p < paths; p++) take(readCompact());
    outputs.push(bytes.slice(start, at));
  }
  if (at !== bytes.length) throw new Error("Trailing bytes after a native transaction");
  return toHex(
    tagged(
      "txid",
      concat(
        fromHex(LOTUS_V2_REGTEST_CHAIN_ID, 32),
        header,
        indexedRoot(cores.map((c) => tagged("inputcore", c))),
        indexedRoot(outputs.map((o) => tagged("output", lengthPrefixed(o))))
      )
    )
  );
}
